/**
 * The ADR-008 R-exact execution journal for the micro-routing plane.
 *
 * This deliberately owns no admission decision: callers must pass the separate
 * constitution/coverage/owner-attestation gate first. Its narrow job is to
 * make a single admitted canary recoverable without an observer: persist an
 * immutable baseline before any write, enforce an absolute deadline, and allow
 * exactly one restore attempt that always terminally disarms.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** This is deliberately identical to the ADR-008 v1 phase vocabulary. */
export type JournalPhase = "prepare" | "apply" | "verify" | "watch" | "commit" | "unknown" | "revert" | "recover" | "quarantine" | "disarm" | "terminally-blocked";
export type JournalOutcome = "prepared" | "applied" | "verified" | "watching" | "committed" | "unknown" | "reverted" | "recovered" | "quarantined" | "disarmed" | "terminally-blocked";
/** A writer must provide a CAS so the baseline check and candidate write are one operation. */
export interface RouteTableStore { read(): string; write(table: string): void; compareAndSwap(expected: string, next: string): boolean; }
export interface RouteMutation { id: string; deadline: string; watchDeadline: string; baseline: string; candidate: string; }
interface Entry { entryId: string; sequence: number; recordedAt: string; phase: JournalPhase; outcome: JournalOutcome; reason: string; previousReceiptDigest: string | null; receiptDigest: string; }
interface State { schemaVersion: 1; mutation: RouteMutation; baselineDigest: string; candidateDigest: string; disarmed: boolean; recoveryAttempted: boolean; entries: Entry[]; }
export interface JournalResult { outcome: JournalOutcome; disarmed: boolean; reason: string; }

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string { return JSON.stringify(value); }
function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid UTC timestamp: ${value}`);
  // The Grimnir contract accepts RFC3339 UTC `Z` form both with and without
  // fractional seconds.  Normalising before equality avoids rejecting its
  // canonical fixture timestamps (for example `...:00Z`).
  const normalized = new Date(ms).toISOString().replace(".000Z", "Z");
  if (value !== new Date(ms).toISOString() && value !== normalized) throw new Error(`invalid UTC timestamp: ${value}`);
  return ms;
}

export class ConstitutionalRoutingJournal {
  private readonly path: string;
  private readonly lockPath: string;
  constructor(private readonly dataDir: string, private readonly table: RouteTableStore, private readonly nowIso: () => string) {
    this.path = join(dataDir, "autonomy-constitution", "micro-routing-journal.json");
    this.lockPath = `${this.path}.lock`;
  }
  exists(): boolean { return existsSync(this.path); }
  /** Startup/timer entrypoint: commit a completed watch before its absolute deadline, otherwise recover. */
  resume(at = this.nowIso()): JournalResult | null {
    return this.locked(() => this.resumeUnlocked(at));
  }
  private resumeUnlocked(at: string): JournalResult | null {
    if (!this.exists()) return null;
    const state = this.load();
    if (state.entries.at(-1)?.outcome === "committed" || state.disarmed) return null;
    if (state.entries.at(-1)?.phase === "watch" && parseIso(at) >= parseIso(state.mutation.watchDeadline)) return this.commitUnlocked(at);
    if (parseIso(at) > parseIso(state.mutation.deadline)) return this.recoverUnlocked("deadline-expired");
    return null;
  }
  prepare(mutation: RouteMutation): JournalResult {
    return this.locked(() => this.prepareUnlocked(mutation));
  }
  private prepareUnlocked(mutation: RouteMutation): JournalResult {
    if (existsSync(this.path)) throw new Error("an autonomous micro-routing journal already exists; recover or clear it through owner procedure");
    if (parseIso(mutation.watchDeadline) > parseIso(mutation.deadline)) throw new Error("watch deadline exceeds operation deadline");
    if (parseIso(this.nowIso()) >= parseIso(mutation.deadline)) throw new Error("late mutation rejected");
    if (this.table.read() !== mutation.baseline) throw new Error("baseline changed before prepare");
    const state: State = { schemaVersion: 1, mutation: { ...mutation }, baselineDigest: digest(mutation.baseline), candidateDigest: digest(mutation.candidate), disarmed: false, recoveryAttempted: false, entries: [] };
    this.append(state, "prepare", "prepared", "prepared"); this.save(state);
    return { outcome: "prepared", disarmed: false, reason: "prepared" };
  }
  apply(): JournalResult {
    return this.locked(() => this.applyUnlocked());
  }
  private applyUnlocked(): JournalResult {
    const state = this.load();
    if (state.disarmed) throw new Error("journal is disarmed");
    if (this.isExpired(state)) return this.recoverUnlocked("deadline-expired-before-apply");
    this.requirePhase(state, "prepare");
    const applied = this.table.compareAndSwap(state.mutation.baseline, state.mutation.candidate);
    if (!applied) return this.unknownAndRecover(state, "baseline-unknown-before-apply");
    if (digest(this.table.read()) !== state.candidateDigest) return this.unknownAndRecover(state, "candidate-readback-failed");
    this.append(state, "apply", "applied", "candidate-readback-matches"); this.save(state);
    return { outcome: "applied", disarmed: false, reason: "candidate-readback-matches" };
  }
  verify(): JournalResult {
    return this.locked(() => this.verifyUnlocked());
  }
  private verifyUnlocked(): JournalResult {
    const state = this.load();
    if (state.disarmed) throw new Error("journal is disarmed");
    if (this.isExpired(state)) return this.recoverUnlocked("deadline-expired-before-verify");
    this.requirePhase(state, "apply");
    if (digest(this.table.read()) !== state.candidateDigest) return this.recoverUnlocked("verify-readback-mismatch");
    this.append(state, "verify", "verified", "verifier-passes"); this.save(state);
    return { outcome: "verified", disarmed: false, reason: "verifier-passes" };
  }
  watch(): JournalResult {
    return this.locked(() => this.watchUnlocked());
  }
  private watchUnlocked(): JournalResult {
    const state = this.load();
    if (state.disarmed) throw new Error("journal is disarmed");
    if (this.isExpired(state)) return this.recoverUnlocked("deadline-expired-before-watch");
    this.requirePhase(state, "verify");
    if (digest(this.table.read()) !== state.candidateDigest) return this.recoverUnlocked("watch-readback-mismatch");
    this.append(state, "watch", "watching", "watch-started"); this.save(state);
    return { outcome: "watching", disarmed: false, reason: "watch-started" };
  }
  commit(at = this.nowIso()): JournalResult {
    return this.locked(() => this.commitUnlocked(at));
  }
  private commitUnlocked(at: string): JournalResult {
    const state = this.load();
    if (state.disarmed) throw new Error("journal is disarmed");
    if (parseIso(at) > parseIso(state.mutation.deadline)) return this.recoverUnlocked("deadline-expired-before-commit");
    this.requirePhase(state, "watch");
    if (parseIso(at) < parseIso(state.mutation.watchDeadline)) throw new Error("watch window has not completed");
    if (digest(this.table.read()) !== state.candidateDigest) return this.recoverUnlocked("commit-readback-mismatch");
    this.append(state, "commit", "committed", "canary-watch-complete"); this.save(state);
    return { outcome: "committed", disarmed: false, reason: "canary-watch-complete" };
  }
  /** Called by startup and an independent deadline watchdog. It never retries. */
  recover(reason: string): JournalResult {
    return this.locked(() => this.recoverUnlocked(reason));
  }
  private recoverUnlocked(reason: string): JournalResult {
    const state = this.load();
    if (state.entries.at(-1)?.outcome === "committed") return { outcome: "terminally-blocked", disarmed: false, reason: "committed-journal-is-not-recoverable" };
    if (state.disarmed) return { outcome: "terminally-blocked", disarmed: true, reason: "recovery-already-consumed" };
    if (state.recoveryAttempted) return this.block(state, "recovery-already-attempted");
    // Unknown is a durable, canonical boundary: after an interrupted or
    // externally changed write no success transition can follow.
    if (state.entries.at(-1)?.phase !== "unknown") { this.append(state, "unknown", "unknown", reason); this.save(state); }
    state.recoveryAttempted = true; this.save(state); // durable before the only external recovery write
    try {
      this.table.write(state.mutation.baseline);
      if (digest(this.table.read()) !== state.baselineDigest) return this.block(state, `${reason}:baseline-readback-failed`);
    } catch (error) { return this.block(state, `${reason}:restore-error:${error instanceof Error ? error.message : String(error)}`); }
    this.append(state, "revert", "reverted", `${reason}:baseline-digest-restored`);
    state.disarmed = true; this.append(state, "disarm", "disarmed", "recovery-worker-disarm-confirmed"); this.save(state);
    return { outcome: "reverted", disarmed: true, reason: "baseline-digest-restored" };
  }
  recoverIfPastDeadline(at = this.nowIso()): JournalResult | null {
    return this.locked(() => this.recoverIfPastDeadlineUnlocked(at));
  }
  private recoverIfPastDeadlineUnlocked(at: string): JournalResult | null {
    const state = this.load();
    if (state.entries.at(-1)?.outcome === "committed") return null;
    return parseIso(at) >= parseIso(state.mutation.deadline) ? this.recoverUnlocked("deadline-expired") : null;
  }
  private load(): State {
    if (!existsSync(this.path)) throw new Error("no constitutional micro-routing journal");
    const state = JSON.parse(readFileSync(this.path, "utf8")) as State;
    if (state.schemaVersion !== 1 || !state.mutation || digest(state.mutation.baseline) !== state.baselineDigest || digest(state.mutation.candidate) !== state.candidateDigest) throw new Error("journal tamper or unknown baseline");
    let previous: string | null = null;
    for (const entry of state.entries) {
      const body = { entryId: entry.entryId, sequence: entry.sequence, recordedAt: entry.recordedAt, phase: entry.phase, outcome: entry.outcome, reason: entry.reason, previousReceiptDigest: entry.previousReceiptDigest };
      if (entry.sequence < 1 || entry.sequence !== state.entries.indexOf(entry) + 1 || entry.previousReceiptDigest !== previous || entry.receiptDigest !== digest(canonical(body))) throw new Error("journal receipt chain tampered");
      previous = entry.receiptDigest;
    }
    return state;
  }
  private save(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${canonical(state)}\n`, "utf8");
    const file = openSync(tmp, "r"); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tmp, this.path);
    const directory = openSync(dirname(this.path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private append(state: State, phase: JournalPhase, outcome: JournalOutcome, reason: string): void { const previousReceiptDigest = state.entries.at(-1)?.receiptDigest ?? null; const body = { entryId: `micro-route-${state.entries.length + 1}`, sequence: state.entries.length + 1, recordedAt: this.nowIso(), phase, outcome, reason, previousReceiptDigest }; state.entries.push({ ...body, receiptDigest: digest(canonical(body)) }); }
  private isExpired(state: State, at = this.nowIso()): boolean { return parseIso(at) >= parseIso(state.mutation.deadline); }
  private requirePhase(state: State, phase: JournalPhase): void { if (state.entries.at(-1)?.phase !== phase) throw new Error(`expected ${phase} phase`); }
  private block(state: State, reason: string): JournalResult { state.disarmed = true; this.append(state, "terminally-blocked", "terminally-blocked", reason); this.save(state); return { outcome: "terminally-blocked", disarmed: true, reason }; }
  private unknownAndRecover(state: State, reason: string): JournalResult {
    this.append(state, "unknown", "unknown", reason); this.save(state);
    return this.recoverUnlocked(reason);
  }
  /**
   * OS-backed exclusion is intentionally independent of the Node process: two
   * timer/controller processes cannot interleave an apply and receipt write.
   * No stale-lock stealing is permitted; operator recovery is fail-closed.
   */
  private locked<T>(operation: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
      fsyncSync(fd);
    } catch (error) {
      throw new Error(`constitutional journal lock unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { return operation(); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(this.lockPath); } catch { /* never mask a completed mutation */ }
    }
  }
}
