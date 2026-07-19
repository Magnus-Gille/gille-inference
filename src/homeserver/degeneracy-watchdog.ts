/**
 * Degeneracy watchdog — Fix #2 (the SILENT backstop) for the Qwen3-Next "?????" degeneration.
 *
 * The primary fix (poison-clear.ts) triggers on an abrupt client DISCONNECT — the event that
 * physically poisons a hybrid recurrent model's SSM state. But the doc records a second, distinct
 * manifestation: a request that COMPLETES cleanly (finish_reason "stop", normal usage) whose body
 * is nonetheless a long run of a single repeated token (`?????…`), because it reused an
 * already-dirty recurrent buffer seeded by an EARLIER disconnect that the gateway never saw (or
 * that landed inside a cooldown window). No disconnect fires on THIS request, so the disconnect-
 * keyed poison-clear never runs and the box keeps serving garbage to everyone until a human
 * restarts it. This watchdog closes that hole: while relaying the SSE stream of a recurrent model,
 * it watches the decoded `delta.content` and flags the degenerate single-token run so the gateway
 * can unload (self-heal) and tell the client to retry — see docs/m5-qwen3next-recurrent-
 * degeneration-2026-06-24.md (ranked fix #2).
 *
 * Signal: the observed symptom is a long run of ONE repeated token, which decodes to a long run of
 * the same character (the `?` case). So the detector tracks the longest run of consecutive IDENTICAL
 * characters across the whole completion (runs carry across delta/chunk boundaries — `??`+`???` is a
 * run of 5) and trips when a run reaches `threshold`.
 *
 * False-positive discipline (this only ever fires for allow-listed RECURRENT models — full-attention
 * models never reach it):
 *   - WHITESPACE is a run breaker. The single biggest source of long legitimate identical-char runs
 *     is whitespace (deep indentation, blank-line runs in code); a whitespace char neither extends a
 *     run nor forms one, so those never trip. The tradeoff: a degeneration whose repeated token is
 *     itself whitespace-separated is not caught — but the observed symptom is a contiguous `?????`
 *     run, and the disconnect-keyed primary fix still covers the common trigger.
 *   - The threshold is deliberately high (default 400). No legitimate prose, code, table rule, or
 *     ASCII art contains 400 consecutive identical NON-whitespace characters; the degeneration emits
 *     thousands. A near-miss legitimate run (a long base64-zero blob on a coding model) costs only a
 *     single unnecessary unload + one retried request — bounded and cheap — whereas a missed
 *     degeneration bricks the box for all users, so the asymmetry favours catching it.
 *
 * Pure + allocation-light: O(chars) with O(1) state, no regex per char, no buffering of the stream.
 * `threshold <= 0` disables it entirely (feed() always returns false).
 */
export class DegeneracyWatchdog {
  private readonly threshold: number;
  /** The character currently repeating, or null at a run boundary (start / after whitespace). */
  private runChar: number | null = null;
  /** Length of the current consecutive-identical-character run. */
  private runLen = 0;
  /** Latched once a run has reached the threshold — never un-trips for the life of the stream. */
  private trippedFlag = false;

  constructor(threshold: number) {
    // Normalize to a non-negative integer: a fractional threshold (e.g. a misconfigured 0.5) would
    // otherwise trip on the very first non-whitespace char (runLen >= 0.5). Math.floor keeps a sane
    // integer run count; <= 0 disables (feed() short-circuits).
    this.threshold = Number.isFinite(threshold) ? Math.floor(threshold) : 0;
  }

  /** True once a degenerate single-token run has been observed on this stream. */
  get tripped(): boolean {
    return this.trippedFlag;
  }

  /** Current consecutive-identical-character run length (observability / tests). */
  get runLength(): number {
    return this.runLen;
  }

  /**
   * Feed the next decoded `delta.content` slice. Returns the LATCHED tripped state, so the caller can
   * branch on the return value of the feed that crossed the threshold (and every feed after it).
   * Whitespace breaks the current run; identical consecutive non-whitespace characters extend it.
   */
  feed(content: string): boolean {
    if (this.threshold <= 0) return false;
    if (this.trippedFlag) return true;
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      // 0x20 space, 0x09 tab, 0x0A LF, 0x0D CR, 0x0C FF, 0x0B VT — the run breakers.
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b) {
        this.runChar = null;
        this.runLen = 0;
        continue;
      }
      if (c === this.runChar) {
        this.runLen++;
      } else {
        this.runChar = c;
        this.runLen = 1;
      }
      if (this.runLen >= this.threshold) {
        this.trippedFlag = true;
        return true;
      }
    }
    return false;
  }
}
