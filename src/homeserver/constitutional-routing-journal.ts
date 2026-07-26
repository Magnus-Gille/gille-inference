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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type JournalPhase = "prepare" | "apply" | "verify" | "watch" | "commit" | "revert" | "terminally-blocked";
export type JournalOutcome = "prepared" | "applied" | "verified" | "watching" | "committed" | "reverted" | "terminally-blocked";
export interface RouteTableStore { read(): string; write(table: string): void; }
export interface RouteMutation { id: string; deadline: string; watchDeadline: string; baseline: string; candidate: string; }
interface Entry { entryId: string; sequence: number; recordedAt: string; phase: JournalPhase; outcome: JournalOutcome; reason: string; previousReceiptDigest: string | null; receiptDigest: string; }
interface State { schemaVersion: 1; mutation: RouteMutation; baselineDigest: string; candidateDigest: string; disarmed: boolean; recoveryAttempted: boolean; entries: Entry[]; }
export interface JournalResult { outcome: JournalOutcome; disarmed: boolean; reason: string; }

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string { return JSON.stringify(value); }
function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`invalid UTC timestamp: ${value}`);
  return ms;
}

export class ConstitutionalRoutingJournal {
  private readonly path: string;
  constructor(private readonly dataDir: string, private readonly table: RouteTableStore, private readonly nowIso: () => string) {
    this.path = join(dataDir, "autonomy-constitution", "micro-routing-journal.json");
  }
  prepare(mutation: RouteMutation): JournalResult {
    if (existsSync(this.path)) throw new Error("an autonomous micro-routing journal already exists; recover or clear it through owner procedure");
    if (parseIso(mutation.watchDeadline) > parseIso(mutation.deadline)) throw new Error("watch deadline exceeds operation deadline");
    if (parseIso(this.nowIso()) >= parseIso(mutation.deadline)) throw new Error("late mutation rejected");
    if (this.table.read() !== mutation.baseline) throw new Error("baseline changed before prepare");
    const state: State = { schemaVersion: 1, mutation: { ...mutation }, baselineDigest: digest(mutation.baseline), candidateDigest: digest(mutation.candidate), disarmed: false, recoveryAttempted: false, entries: [] };
    this.append(state, "prepare", "prepared", "prepared"); this.save(state);
    return { outcome: "prepared", disarmed: false, reason: "prepared" };
  }
  apply(): JournalResult {
    const state = this.load(); this.assertActiveAndOnTime(state);
    this.requirePhase(state, "prepare");
    if (digest(this.table.read()) !== state.baselineDigest) return this.block(state, "baseline-unknown-before-apply");
    this.table.write(state.mutation.candidate);
    if (digest(this.table.read()) !== state.candidateDigest) return this.block(state, "candidate-readback-failed");
    this.append(state, "apply", "applied", "candidate-readback-matches"); this.save(state);
    return { outcome: "applied", disarmed: false, reason: "candidate-readback-matches" };
  }
  verify(): JournalResult {
    const state = this.load(); this.assertActiveAndOnTime(state); this.requirePhase(state, "apply");
    if (digest(this.table.read()) !== state.candidateDigest) return this.recover("verify-readback-mismatch");
    this.append(state, "verify", "verified", "verifier-passes"); this.save(state);
    return { outcome: "verified", disarmed: false, reason: "verifier-passes" };
  }
  watch(): JournalResult {
    const state = this.load(); this.assertActiveAndOnTime(state); this.requirePhase(state, "verify");
    if (digest(this.table.read()) !== state.candidateDigest) return this.recover("watch-readback-mismatch");
    this.append(state, "watch", "watching", "watch-started"); this.save(state);
    return { outcome: "watching", disarmed: false, reason: "watch-started" };
  }
  commit(at = this.nowIso()): JournalResult {
    const state = this.load(); this.assertActiveAndOnTime(state, at); this.requirePhase(state, "watch");
    if (parseIso(at) < parseIso(state.mutation.watchDeadline)) throw new Error("watch window has not completed");
    if (digest(this.table.read()) !== state.candidateDigest) return this.recover("commit-readback-mismatch");
    this.append(state, "commit", "committed", "canary-watch-complete"); this.save(state);
    return { outcome: "committed", disarmed: false, reason: "canary-watch-complete" };
  }
  /** Called by startup and an independent deadline watchdog. It never retries. */
  recover(reason: string): JournalResult {
    const state = this.load();
    if (state.entries.at(-1)?.outcome === "committed") return { outcome: "terminally-blocked", disarmed: false, reason: "committed-journal-is-not-recoverable" };
    if (state.recoveryAttempted) return this.block(state, "recovery-already-attempted");
    state.recoveryAttempted = true; this.save(state); // durable before the only external recovery write
    try {
      this.table.write(state.mutation.baseline);
      if (digest(this.table.read()) !== state.baselineDigest) return this.block(state, `${reason}:baseline-readback-failed`);
    } catch (error) { return this.block(state, `${reason}:restore-error:${error instanceof Error ? error.message : String(error)}`); }
    state.disarmed = true; this.append(state, "revert", "reverted", `${reason}:baseline-digest-restored`); this.save(state);
    return { outcome: "reverted", disarmed: true, reason: "baseline-digest-restored" };
  }
  recoverIfPastDeadline(at = this.nowIso()): JournalResult | null {
    const state = this.load();
    if (state.entries.at(-1)?.outcome === "committed") return null;
    return parseIso(at) >= parseIso(state.mutation.deadline) ? this.recover("deadline-expired") : null;
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
  private assertActiveAndOnTime(state: State, at = this.nowIso()): void { if (state.disarmed) throw new Error("journal is disarmed"); if (parseIso(at) >= parseIso(state.mutation.deadline)) throw new Error("late mutation rejected; recovery is required"); }
  private requirePhase(state: State, phase: JournalPhase): void { if (state.entries.at(-1)?.phase !== phase) throw new Error(`expected ${phase} phase`); }
  private block(state: State, reason: string): JournalResult { state.disarmed = true; this.append(state, "terminally-blocked", "terminally-blocked", reason); this.save(state); return { outcome: "terminally-blocked", disarmed: true, reason }; }
}
