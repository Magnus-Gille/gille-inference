/** Bounded, non-queuing admission for audio request bodies before they are buffered. */
export class AudioUploadAdmission {
  private active = 0;
  private guestActive = 0;
  private readonly byAlias = new Map<string, number>();

  acquire(alias: string, tier: "owner" | "guest", maxParallel: number): (() => void) | null {
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 0) return null;
    const keyCap = Math.min(2, maxParallel);
    if (
      alias.length === 0 ||
      keyCap === 0 ||
      this.active >= 2 ||
      (tier === "guest" && this.guestActive >= 1) ||
      (this.byAlias.get(alias) ?? 0) >= keyCap
    ) {
      return null;
    }

    this.active++;
    if (tier === "guest") this.guestActive++;
    this.byAlias.set(alias, (this.byAlias.get(alias) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (tier === "guest") this.guestActive--;
      const remaining = (this.byAlias.get(alias) ?? 1) - 1;
      if (remaining <= 0) this.byAlias.delete(alias);
      else this.byAlias.set(alias, remaining);
    };
  }
}
