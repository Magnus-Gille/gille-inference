import { constants as fsConstants, mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, fstatSync, readSync, writeSync, realpathSync, existsSync, readdirSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { dirname, join, sep, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX } from "./code-loop-types.js";
import type {
  CodeLoopRequest,
  CodeLoopCaps,
  CodeLoopCapsRequest,
  CodeLoopCapsConfig,
  CodeLoopStartResult,
  CodeLoopJobStatus,
  CodeLoopTerminalStatus,
  CodeLoopResult,
  CodeLoopUsage,
  CodeLoopTelemetry,
  CodeLoopDeps,
} from "./code-loop-types.js";
import {
  claimDurableCodeLoopRun,
  acquireDurableCodeLoopLease,
  compactExpiredDurableCodeLoopRuns,
  compactDurableCodeLoopRunResult,
  codeLoopRequestFingerprint,
  isDurableCodeLoopWorkLive,
  markDurableCodeLoopRunOrphaned,
  markUnownedDurableCodeLoopRunsOrphaned,
  persistDurableCodeLoopRun,
  readDurableCodeLoopRunByClient,
  readDurableCodeLoopRunByWork,
  removeDurableCodeLoopRun,
  validateClientRunId,
  type DurableCodeLoopRun,
} from "./code-loop-store.js";
import { recordDelegation, type Outcome, type ErrorClass } from "./ledger.js";
import { classifyTask } from "./taxonomy.js";
import { recordCodeLoopRun, setCodeLoopActive } from "./metrics.js";
import {
  TASK_FINGERPRINT_VERSION,
  recordTaskExposureBestEffort,
} from "./task-exposure.js";

/**
 * code_loop harness (issue #116, docs/agentic-code-tool-design.md §5, §7, §9, §10).
 *
 * Owns the job table, the throwaway-sandbox lifecycle (seed → nested `git init` → run →
 * harvest → retain), cap enforcement, the single-run mutex, the GPU-lease wrap, maintenance
 * refusal, the startup sweep, and the per-run `recordDelegation()` write. The DELIVERABLE is a
 * git diff vs the seed commit — the box never mutates a live checkout.
 */

// ─── MCP tool catalogue (owner-only; appended by mcp.ts when the gate passes) ───────────

export const CODE_LOOP_TOOL_NAMES = ["code_loop_start", "code_loop_status", "code_loop_result"] as const;

/** Immutable wire/harness contract identifier reported in every #247 result. */
export const CODE_LOOP_HARNESS_VERSION = "code-loop-pi-2026-07-14-v6";
export const CODE_LOOP_CAPABILITIES = {
  start_idempotency: "client-run-id-v1",
  agent_checks: "pi-bash-events-v3",
} as const;
export const CODE_LOOP_TOOL_CONTRACT_ADVERTISEMENT =
  `contract[harness=${CODE_LOOP_HARNESS_VERSION};agent_checks=${CODE_LOOP_CAPABILITIES.agent_checks};` +
  `schema=3;max_attempts=${CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX}]`;

function isCurrentCodeLoopResult(result: CodeLoopResult): boolean {
  return result.execution?.schema_version === 1 &&
    result.execution.harness_version === CODE_LOOP_HARNESS_VERSION &&
    result.execution.capabilities?.agent_checks === CODE_LOOP_CAPABILITIES.agent_checks &&
    result.agent_checks?.schema_version === 3 &&
    result.agent_checks.source === "pi-bash-events" &&
    Array.isArray(result.agent_checks.attempts) &&
    result.agent_checks.attempts.length <= CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX;
}

function failClosedIncompatibleResult(workroot: string, record: DurableCodeLoopRun): DurableCodeLoopRun {
  if (record.result === null || isCurrentCodeLoopResult(record.result)) return record;
  // A terminal payload created by an older harness cannot be relabelled as current evidence.
  // Compact it to the existing terminal-unavailable state; even an I/O failure never exposes it.
  try { compactDurableCodeLoopRunResult(workroot, record.work_id); } catch { /* fail closed in memory */ }
  return { ...record, result: null };
}

export function isCodeLoopToolName(name: string): boolean {
  return (CODE_LOOP_TOOL_NAMES as readonly string[]).includes(name);
}

export function codeLoopToolDefs(): unknown[] {
  return [
    {
      name: "code_loop_start",
      description:
        "OWNER-ONLY. Start an ASYNC sandboxed agentic coding run on the box: a pi subprocess (native " +
        "tool-calling, read/edit/write/bash) drives the local coding model inside an OS cage against " +
        "caller-supplied seed files. An optional client_run_id makes start durable and idempotent. " +
        "Returns a work_id immediately; poll code_loop_status and fetch " +
        "code_loop_result. The deliverable is a git diff vs the seed commit — the box never touches a " +
        "live checkout. Provide the files the task needs (≤64 / ≤2MB), the instruction, and optionally " +
        `an owner-authored check_cmd + protected globs. ${CODE_LOOP_TOOL_CONTRACT_ADVERTISEMENT}`,
      inputSchema: {
        type: "object",
        properties: {
          client_run_id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            description: "optional durable caller idempotency key (client-run-id-v1)",
          },
          instruction: { type: "string", description: "the task prompt" },
          files: {
            type: "array",
            description: "seed files (relative paths); required in Phase 1",
            items: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
            },
          },
          check_cmd: { type: "string", description: "owner-authored verification command run in the sandbox post-loop (120s cap)" },
          protected: { type: "array", items: { type: "string" }, description: "globs whose modification is reported at exit" },
          task_type: { type: "string", description: "ledger task type (defaults to the classifier)" },
          caps: {
            type: "object",
            properties: {
              wall_s: { type: "number" },
              turns: { type: "number" },
              completion_tokens: { type: "number" },
              edit_deadline_turn: {
                type: "integer",
                minimum: 1,
                description: "optional first edit/write deadline; must be <= effective turns",
              },
            },
          },
        },
        required: ["instruction", "files"],
      },
    },
    {
      name: "code_loop_status",
      description: "OWNER-ONLY. Poll a code_loop run: returns {status, usage}. work_id from code_loop_start.",
      inputSchema: { type: "object", properties: { work_id: { type: "string" } }, required: ["work_id"] },
    },
    {
      name: "code_loop_result",
      description:
        "OWNER-ONLY. Fetch a finished code_loop run: the git diff, changed files, protected violations, " +
        "pi's summary, the check result, and usage. Re-fetchable until the 24h TTL sweep.",
      inputSchema: { type: "object", properties: { work_id: { type: "string" } }, required: ["work_id"] },
    },
  ];
}

// ─── Caps ───────────────────────────────────────────────────────────────────────────────

function clampInt(v: number | undefined, def: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(Math.max(Math.floor(v), 1), max);
}

export function clampCaps(req: CodeLoopCapsRequest | undefined, c: CodeLoopCapsConfig): CodeLoopCaps {
  const turns = clampInt(req?.turns, c.turnsDefault, c.turnsMax);
  const deadline = req?.edit_deadline_turn;
  return {
    wall_s: clampInt(req?.wall_s, c.wallSDefault, c.wallSMax),
    turns,
    completion_tokens: clampInt(req?.completion_tokens, c.tokensDefault, c.tokensMax),
    ...(typeof deadline === "number" && Number.isInteger(deadline) && deadline >= 1 && deadline <= turns
      ? { edit_deadline_turn: deadline }
      : {}),
  };
}

// ─── Request validation ─────────────────────────────────────────────────────────────────

const MAX_FILES = 64;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type ValidateResult =
  | { ok: true; caps: CodeLoopCaps }
  | { ok: false; message: string };

export function validateCodeLoopRequest(req: CodeLoopRequest, capsConfig: CodeLoopCapsConfig): ValidateResult {
  try {
    validateClientRunId(req.client_run_id);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (typeof req.instruction !== "string" || req.instruction.trim() === "") {
    return { ok: false, message: "`instruction` is required." };
  }
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return { ok: false, message: "`files` is required in Phase 1 (inline seeding) — provide at least one file." };
  }
  if (req.files.length > MAX_FILES) {
    return { ok: false, message: `Too many seed files (${req.files.length} > ${MAX_FILES}).` };
  }
  let total = 0;
  const seenPaths = new Set<string>();
  for (const f of req.files) {
    if (typeof f.path !== "string" || typeof f.content !== "string") {
      return { ok: false, message: "Each seed file needs a string `path` and string `content`." };
    }
    if (seenPaths.has(f.path)) return { ok: false, message: `Duplicate seed path '${f.path}'.` };
    seenPaths.add(f.path);
    total += Buffer.byteLength(f.content, "utf8");
  }
  if (total > MAX_TOTAL_BYTES) {
    return { ok: false, message: `Seed content too large (${total} bytes > ${MAX_TOTAL_BYTES}).` };
  }
  const caps = clampCaps(req.caps, capsConfig);
  const rawDeadline = req.caps?.edit_deadline_turn;
  if (rawDeadline !== undefined) {
    if (typeof rawDeadline !== "number" || !Number.isInteger(rawDeadline) || rawDeadline < 1) {
      return { ok: false, message: "`caps.edit_deadline_turn` must be a positive integer." };
    }
    if (rawDeadline > caps.turns) {
      return {
        ok: false,
        message: `\`caps.edit_deadline_turn\` (${rawDeadline}) must be <= effective turns (${caps.turns}).`,
      };
    }
  }
  return { ok: true, caps };
}

const EDIT_DEADLINE_POLICY_VERSION = 1;

/** Stable prompt wrapper. With no deadline the original instruction is returned byte-for-byte. */
export function applyEditDeadlinePolicy(instruction: string, deadlineTurn: number | undefined): string {
  if (deadlineTurn === undefined) return instruction;
  return (
    `[code_loop edit-deadline policy v${EDIT_DEADLINE_POLICY_VERSION}]\n` +
    `Complete your first file mutation using the edit or write tool no later than agent turn ${deadlineTurn}. ` +
    "Inspect only what you need, then edit. The harness will terminate the run if the deadline is missed.\n" +
    "[/code_loop edit-deadline policy]\n\n" +
    instruction
  );
}

// ─── Seed containment (hardened: lexical + realpath + wx) ───────────────────────────────

/**
 * Materialize seed files into the sandbox with a HARDENED containment check (design §5):
 *   1. lexical: relative, no traversal, no absolute, no NUL, never into .git/
 *   2. realpath: the resolved PARENT directory must be inside the sandbox realpath (defeats a
 *      symlink-parent escape — the pure-lexical resolveContained() alone does NOT stop this)
 *   3. wx: create with O_WRONLY|O_CREAT|O_EXCL — never follow/overwrite a pre-existing entry
 */
export function seedSandbox(sandboxDir: string, files: Array<{ path: string; content: string }>): void {
  // Absolutize FIRST: resolve() below returns absolute paths, so a RELATIVE sandboxDir (the
  // live default workroot is ./data/code-loop-work) would fail every startsWith comparison and
  // refuse ALL seeds — found by the first live smoke, 2026-07-02.
  const baseAbs = resolve(sandboxDir);
  const baseReal = realpathSync(baseAbs);
  for (const f of files) {
    const rel = f.path;
    if (rel.includes("\0")) throw new Error(`code-loop: seed path contains a NUL byte — refusing.`);
    if (isAbsolute(rel)) throw new Error(`code-loop: seed path '${rel}' is absolute — only relative paths are allowed.`);
    // Lexical containment against the (non-realpath) base, mirroring resolveContained().
    const lexical = resolve(baseAbs, rel);
    if (lexical !== baseAbs && !lexical.startsWith(baseAbs + sep)) {
      throw new Error(`code-loop: seed path '${rel}' escapes the sandbox — refusing.`);
    }
    // Reject any component that is `.git` (protect the diff baseline + host git ops).
    if (/(^|[\\/])\.git([\\/]|$)/.test(rel)) {
      throw new Error(`code-loop: seed path '${rel}' targets a .git directory — refusing.`);
    }
    // Create parent dirs lexically, THEN realpath-verify the parent is still inside the sandbox.
    const parentLexical = dirname(lexical);
    mkdirSync(parentLexical, { recursive: true });
    const parentReal = realpathSync(parentLexical);
    if (parentReal !== baseReal && !parentReal.startsWith(baseReal + sep)) {
      throw new Error(`code-loop: seed path '${rel}' resolves (via a symlink) outside the sandbox — refusing.`);
    }
    // wx creation: O_EXCL means we never follow a symlink at the target nor overwrite an entry.
    let fd: number;
    try {
      fd = openSync(lexical, "wx");
    } catch (err) {
      throw new Error(`code-loop: cannot create seed file '${rel}' (exists or symlinked): ${(err as Error).message}`);
    }
    try {
      writeSync(fd, f.content);
    } finally {
      closeSync(fd);
    }
  }
}

// ─── Minimal glob matcher (protected paths / changed-file re-validation) ─────────────────

/**
 * Convert a glob to a RegExp anchored on the whole path. Dep-free. Supports:
 *   `**` → any characters, including `/` (so `test/**` matches `test/x.ts` AND `test/a/b.ts`)
 *   `*`  → any characters except `/` (stays within a path segment)
 *   `?`  → a single non-`/` character
 * A leading double-star followed by a slash also matches zero directories.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` → zero-or-more leading directories
        } else {
          re += ".*"; // `**` (e.g. trailing) → anything incl. `/`
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ─── Job table ──────────────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  status: CodeLoopJobStatus;
  sandboxDir: string;
  model: string;
  taskType: string;
  checkCmd: string | null;
  protectedGlobs: string[];
  startedAtMs: number;
  effectiveCaps: CodeLoopCaps;
  usage: CodeLoopUsage;
  engineTelemetry: NonNullable<import("./code-loop-types.js").EngineRunResult["telemetry"]> | null;
  result: CodeLoopResult | null;
  /** pi's final assistant message, carried from engine.run() to the result assembly. */
  summary: string;
  workroot: string;
  clientRunId: string | null;
  requestFingerprint: string | null;
  /** Always present; omitted caller IDs receive an unreachable server-only durable identity. */
  durableClientRunId: string;
  durableRequestFingerprint: string;
}

const jobs = new Map<string, Job>();
let runningWorkId: string | null = null; // single-flight mutex

export function _resetCodeLoopStateForTests(): void {
  jobs.clear();
  runningWorkId = null;
  setCodeLoopActive(false);
}

function newWorkId(now: number): string {
  const d = new Date(now);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `cl-${ymd}-${randomUUID().slice(0, 8)}`;
}

// ─── Meta record (for the orphan sweep across a gateway restart) ─────────────────────────

interface MetaRecord {
  work_id: string;
  status: CodeLoopJobStatus;
  scope_unit: string;
  model: string;
  started_at_ms: number;
}

function writeMeta(sandboxDir: string, m: MetaRecord, writer: (path: string, content: string) => void = writeFileSync): void {
  try {
    writer(join(sandboxDir, ".meta.json"), JSON.stringify(m, null, 2));
  } catch {
    /* best-effort */
  }
}

/**
 * The transient scope unit a run creates is DETERMINISTICALLY `code-loop-<workId>`, and workId is
 * `cl-YYYYMMDD-<8 hex>` (newWorkId). The orphan sweep reads `scope_unit` from an in-sandbox
 * `.meta.json` that a hostile pi CAN overwrite (the sandbox is its only writable path), so the
 * sweep must only ever hand `systemctl --user stop` a name matching this exact shape — never an
 * attacker-chosen unit (which would let a prompt-injected run stop arbitrary user services on the
 * next gateway restart).
 */
const CODE_LOOP_UNIT_RE = /^code-loop-cl-\d{8}-[0-9a-f]{8}$/;
export function isCodeLoopUnitName(unit: string): boolean {
  return CODE_LOOP_UNIT_RE.test(unit);
}

// ─── Ledger outcome mapping (design §9) ─────────────────────────────────────────────────

export function ledgerOutcome(
  status: CodeLoopTerminalStatus,
  check: { ran: boolean; exit_code: number | null }
): { outcome: Outcome; errorClass: ErrorClass | null } {
  // degeneracy = serving-layer pathology → infra (must not poison the model's capability verdict).
  if (status === "degenerate" || status === "orphaned") return { outcome: "error", errorClass: "infra" };
  if (status === "arm-error") return { outcome: "error", errorClass: "infra" };
  if (status === "cap-exceeded") return { outcome: "error", errorClass: "timeout" };
  // completed:
  if (check.ran) return check.exit_code === 0 ? { outcome: "pass", errorClass: null } : { outcome: "fail", errorClass: null };
  return { outcome: "unverified", errorClass: null };
}

// ─── Start ──────────────────────────────────────────────────────────────────────────────

export interface CodeLoopStartConfig {
  enabled: boolean;
  workroot: string;
  model: string;
  caps: CodeLoopCapsConfig;
  confinement: "required" | "off";
  /** Builds the cage argv for a sandbox, and the self-test. null when confinement is off. */
  cage: {
    buildArgv: (sandboxDir: string, unitName: string) => string[];
  } | null;
}

const DIFF_MAX_BYTES = 200 * 1024;
const LEASE_TIMEOUT_MS = 60_000;
const META_MAX_BYTES = 64 * 1024;

function recordCodeLoopTaskExposure(
  req: CodeLoopRequest,
  workId: string,
  modelId: string | null,
  harnessId: string | null
): void {
  recordTaskExposureBestEffort({
    taskText: req.instruction,
    lane: "code-loop",
    modelId,
    harnessId,
    eventKey: `code-loop:${workId}:${TASK_FINGERPRINT_VERSION}`,
  });
}

/**
 * Start an async code_loop job. Returns immediately with a work_id (status "running") or a
 * structured refusal. The run proceeds fire-and-forget; the caller polls status/result.
 */
export async function startCodeLoop(
  req: CodeLoopRequest,
  cfg: CodeLoopStartConfig,
  deps: CodeLoopDeps
): Promise<CodeLoopStartResult> {
  const valid = validateCodeLoopRequest(req, cfg.caps);
  if (!valid.ok) return { ok: false, refusal: "invalid-request", message: valid.message };
  const clientRunId = validateClientRunId(req.client_run_id);
  const taskType = req.task_type && req.task_type.trim() !== "" ? req.task_type : classifyTask(req.instruction).taskType;
  const requestFingerprint = clientRunId === null
    ? null
    : codeLoopRequestFingerprint(req);

  // Recovery is checked before every admission refusal — especially the global single-flight
  // busy gate. Retrying an ambiguous start must recover the original run, not look like new work.
  if (clientRunId !== null) {
    let existing = readDurableCodeLoopRunByClient(cfg.workroot, clientRunId);
    if (existing !== null) {
      if (existing.status === "running" && !isDurableCodeLoopWorkLive(cfg.workroot, existing.work_id)) {
        markDurableCodeLoopRunOrphaned(cfg.workroot, existing.work_id);
        existing = readDurableCodeLoopRunByClient(cfg.workroot, clientRunId) ?? existing;
      }
      if (existing.request_fingerprint !== requestFingerprint) {
        return {
          ok: false,
          refusal: "conflict",
          message: "`client_run_id` is already bound to a different canonical request fingerprint.",
        };
      }
      // A post-deploy retry normally hits the event written at original acceptance. For a
      // pre-feature recovered run, publish only metadata retained in its terminal result; never
      // relabel an older/running harness with today's configured model or contract version.
      recordCodeLoopTaskExposure(
        req,
        existing.work_id,
        existing.result?.execution.model ?? null,
        existing.result?.execution.harness_version ?? null
      );
      return startResultFromRecord(failClosedIncompatibleResult(cfg.workroot, existing), true);
    }
  }

  if (!cfg.enabled) {
    return { ok: false, refusal: "disabled", message: "code_loop is disabled on this box (HOMESERVER_CODE_LOOP=off)." };
  }

  if (deps.maintenanceMode()) {
    return { ok: false, refusal: "maintenance", message: "The box is in maintenance mode (a model-scout window is engaged). Try again shortly." };
  }
  if (runningWorkId !== null) {
    return { ok: false, refusal: "busy", message: "A code_loop run is already in progress (single-flight). Retry when it finishes." };
  }

  // Claim the single-flight mutex SYNCHRONOUSLY — before the cage self-test await below. The
  // busy-check and this claim must not straddle an await, or two concurrent starts both pass the
  // check (TOCTOU) and both spawn a run (violating the exactly-1 invariant / the 2026-07-01 OOM
  // lesson). Released on every subsequent refusal path.
  const now = deps.now();
  const workId = newWorkId(now);
  runningWorkId = workId;

  // The in-memory mutex above protects one gateway process; this durable lease protects against
  // overlapping old/new gateway processes during restarts and is held through finalization.
  let processLeaseClaim: ReturnType<typeof acquireDurableCodeLoopLease>;
  try {
    processLeaseClaim = acquireDurableCodeLoopLease(cfg.workroot, workId, undefined, {
      // runningWorkId was null immediately before this synchronous claim, so a row bearing this
      // process instance can only be residue from a prior release that exhausted its retries.
      reclaimOwnInstance: true,
    });
  } catch (err) {
    runningWorkId = null;
    return { ok: false, refusal: "invalid-request", message: `Could not acquire durable process lease: ${(err as Error).message}` };
  }
  if (processLeaseClaim.kind === "busy") {
    runningWorkId = null;
    return { ok: false, refusal: "busy", message: "A code_loop run is already in progress in another gateway process. Retry when it finishes." };
  }
  const processLease = processLeaseClaim.lease;

  let durable: DurableCodeLoopRun | null = null;
  let sandboxDir: string | null = null;
  const rollbackAdmission = (): void => {
    if (durable !== null) {
      try { removeDurableCodeLoopRun(cfg.workroot, durable.client_run_id, durable.work_id); } catch { /* best effort */ }
    }
    if (sandboxDir !== null) {
      try { rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    try { processLease.release(); } catch (err) {
      console.error(`code_loop durable process lease release failed for ${workId}: ${(err as Error).message}`);
    }
    if (runningWorkId === workId) runningWorkId = null;
  };
  // Cage self-test gate (design §6). With confinement=required, a failing probe refuses the job.
  if (cfg.confinement === "required") {
    let probe: { ok: boolean; failures: string[] };
    try {
      probe = await deps.cageSelfTest();
    } catch (err) {
      probe = { ok: false, failures: [(err as Error).message] };
    }
    if (!probe.ok) {
      rollbackAdmission();
      return { ok: false, refusal: "cage-unavailable", message: `The OS cage self-test failed — refusing to run uncaged: ${probe.failures.join("; ")}` };
    }
  }

  try {
    mkdirSync(cfg.workroot, { recursive: true });
    sandboxDir = mkdtempSync(join(cfg.workroot, `${workId}-`));
    seedSandbox(sandboxDir, req.files);
  } catch (err) {
    rollbackAdmission();
    return { ok: false, refusal: "invalid-request", message: `Seeding failed: ${(err as Error).message}` };
  }

  // Acquire the GPU lease for the WHOLE run (design §8). No admission wrap on the outer call.
  let lease: { release: () => Promise<void> } | null;
  let leaseLost = false;
  try {
    lease = await deps.acquireLease({
      model: cfg.model,
      timeoutMs: LEASE_TIMEOUT_MS,
      onLeaseLost: () => {
        leaseLost = true;
      },
    });
  } catch {
    lease = null;
  }
  if (lease === null) {
    rollbackAdmission();
    return { ok: false, refusal: "lease-unavailable", message: "The GPU is busy (lease not acquired within 60s). Retry shortly." };
  }

  const unitName = `code-loop-${workId}`;
  let cageArgv: string[];
  try {
    cageArgv = cfg.cage !== null ? cfg.cage.buildArgv(sandboxDir, unitName) : [];
  } catch (err) {
    try { await lease.release(); } catch { /* best effort */ }
    rollbackAdmission();
    return { ok: false, refusal: "cage-unavailable", message: `Could not construct the OS cage: ${(err as Error).message}` };
  }

  // Publish caller identity only after every transient admission (cage, seeding, GPU lease) has
  // succeeded, but immediately before the job becomes observable/engine work begins. A retry
  // racing a failed admission sees only `busy`, never a recovered work_id that rollback erases.
  const acceptedAt = deps.now();
  const durableClientRunId = clientRunId ?? `__internal__/${workId}`;
  const durableRequestFingerprint = requestFingerprint ?? codeLoopRequestFingerprint(req);
  {
    const candidate: DurableCodeLoopRun = {
      schema_version: 1,
      client_run_id: durableClientRunId,
      request_fingerprint: durableRequestFingerprint,
      work_id: workId,
      status: "running",
      usage: { turns: 0, wall_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
      result: null,
      started_at_ms: acceptedAt,
    };
    try {
      const claim = claimDurableCodeLoopRun(cfg.workroot, candidate);
      if (claim.kind === "conflict" || claim.kind === "existing") {
        try { await lease.release(); } catch { /* best effort */ }
        rollbackAdmission();
        if (claim.kind === "existing" && clientRunId !== null) {
          return startResultFromRecord(failClosedIncompatibleResult(cfg.workroot, claim.record), true);
        }
        if (clientRunId === null) {
          return {
            ok: false,
            refusal: "invalid-request",
            message: "Generated work identity collision; retry the request.",
          };
        }
        return {
          ok: false,
          refusal: "conflict",
          message: "`client_run_id` is already bound to a different canonical request fingerprint.",
        };
      }
      durable = claim.record;
    } catch (err) {
      try { await lease.release(); } catch { /* best effort */ }
      rollbackAdmission();
      return { ok: false, refusal: "invalid-request", message: `Could not durably bind run identity: ${(err as Error).message}` };
    }
  }

  const job: Job = {
    id: workId,
    status: "running",
    sandboxDir,
    model: cfg.model,
    taskType,
    checkCmd: typeof req.check_cmd === "string" && req.check_cmd.trim() !== "" ? req.check_cmd : null,
    protectedGlobs: Array.isArray(req.protected) ? req.protected.filter((g) => typeof g === "string") : [],
    startedAtMs: acceptedAt,
    effectiveCaps: valid.caps,
    usage: { turns: 0, wall_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
    engineTelemetry: null,
    result: null,
    summary: "",
    workroot: cfg.workroot,
    clientRunId,
    requestFingerprint,
    durableClientRunId,
    durableRequestFingerprint,
  };
  jobs.set(workId, job);
  // The run is durably accepted and about to reach the model. A recovered retry uses the same
  // work-id event key above, so caller ambiguity cannot double-count exposure.
  recordCodeLoopTaskExposure(req, workId, cfg.model, CODE_LOOP_HARNESS_VERSION);
  // Metadata is an untrusted operational hint, never part of acceptance. A filesystem failure
  // here cannot reject the RPC after the durable commit or prevent the already-admitted engine
  // from being scheduled (the durable record drives recovery/retention).
  writeMeta(
    sandboxDir,
    { work_id: workId, status: "running", scope_unit: unitName, model: cfg.model, started_at_ms: acceptedAt },
    deps.writeMeta ?? writeFileSync
  );

  const growthCapBytes = deps.growthCapBytes;

  // Fire-and-forget the run; start returns immediately.
  setCodeLoopActive(true);
  void runJob(job, req, deps, cageArgv, growthCapBytes, unitName, () => leaseLost)
    .finally(async () => {
      try {
        await lease!.release();
      } catch {
        /* lease already gone */
      }
      try {
        processLease.release();
      } catch (err) {
        console.error(`code_loop durable process lease release failed for ${workId}: ${(err as Error).message}`);
      } finally {
        setCodeLoopActive(false);
        if (runningWorkId === workId) runningWorkId = null;
      }
    });

  return {
    ok: true,
    work_id: workId,
    status: "running",
    client_run_id: clientRunId,
    request_fingerprint: requestFingerprint,
    recovered: false,
    capabilities: CODE_LOOP_CAPABILITIES,
  };
}

function startResultFromRecord(record: DurableCodeLoopRun, recovered: boolean): Extract<CodeLoopStartResult, { ok: true }> {
  return {
    ok: true,
    work_id: record.work_id,
    status: record.status,
    client_run_id: record.client_run_id,
    request_fingerprint: record.request_fingerprint,
    recovered,
    ...(record.result !== null && isCurrentCodeLoopResult(record.result) ? { result: record.result } : {}),
    capabilities: CODE_LOOP_CAPABILITIES,
  };
}

// ─── The run ────────────────────────────────────────────────────────────────────────────

async function runJob(
  job: Job,
  req: CodeLoopRequest,
  deps: CodeLoopDeps,
  cageArgv: string[],
  growthCapBytes: number,
  unitName: string,
  leaseLost: () => boolean
): Promise<void> {
  const caps = job.effectiveCaps;
  const seedSha = await gitInitSeed(job.sandboxDir, deps);

  let outcome: CodeLoopTerminalStatus;
  let detail = "";
  try {
    const run = await deps.engine.run({
      sandboxDir: job.sandboxDir,
      instruction: applyEditDeadlinePolicy(req.instruction, caps.edit_deadline_turn),
      model: job.model,
      caps,
      cageArgv,
      growthCapBytes,
    });
    job.usage = run.usage;
    job.engineTelemetry = run.telemetry ?? null;
    detail = run.detail;
    outcome = leaseLost() ? "arm-error" : run.outcome;
    if (leaseLost()) detail = "GPU lease lost mid-run (preempted).";
    job.summary = run.finalMessage;
  } catch (err) {
    outcome = "arm-error";
    detail = `engine error: ${(err as Error).message}`;
    job.summary = "";
  }

  // Harvest the diff from git (ground truth), on ALL terminal statuses (best-effort).
  const harvest = await gitHarvest(job.sandboxDir, seedSha, deps);
  const protectedViolations = harvest.changedFiles.filter((f) => matchesAnyGlob(f, job.protectedGlobs));

  // Run check_cmd inside the SAME cage (design §6) only on a completed run.
  let check = { ran: false, exit_code: null as number | null, output_tail: "" };
  let checkDurationMs: number | undefined;
  if (outcome === "completed" && job.checkCmd !== null && protectedViolations.length === 0) {
    const checkStartedAt = deps.now();
    check = await runCheck(job.checkCmd, job.sandboxDir, cageArgv, deps);
    checkDurationMs = Math.max(0, deps.now() - checkStartedAt);
  }

  const telemetry = buildResultTelemetry(job, harvest.changedFiles.length > 0, checkDurationMs);

  const result: CodeLoopResult = {
    status: outcome,
    diff: harvest.diff.slice(0, DIFF_MAX_BYTES),
    diff_truncated: harvest.diff.length > DIFF_MAX_BYTES,
    changed_files: harvest.changedFiles,
    protected_violations: protectedViolations,
    summary: job.summary.slice(0, 2048),
    check,
    usage: job.usage,
    execution: codeLoopExecution(job),
    telemetry,
    agent_checks: codeLoopAgentChecks(job),
    work_id: job.id,
    // Surface the engine's failure detail (spawn error / stderr tail / cap) to the MCP caller —
    // an arm-error with empty everything cost a manual sandbox dig (live smoke, 2026-07-02).
    detail: detail.slice(0, 400),
  };
  finalizeJobWithResult(job, result, req, deps, unitName);
}

function codeLoopExecution(job: Job): CodeLoopResult["execution"] {
  return {
    schema_version: 1,
    model: job.model,
    engine: "pi",
    harness_version: CODE_LOOP_HARNESS_VERSION,
    effective_caps: job.effectiveCaps,
    capabilities: CODE_LOOP_CAPABILITIES,
  };
}

function codeLoopAgentChecks(job: Job): CodeLoopResult["agent_checks"] {
  const rawAttempts = job.engineTelemetry?.agent_checks ?? [];
  const attempts = rawAttempts.slice(0, CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX)
    .map((attempt, index) => ({ ...attempt, order: index + 1 }));
  const droppedAttempts = rawAttempts.length - attempts.length;
  const unparseableLines = job.engineTelemetry?.agent_check_unparseable_lines ?? 0;
  // Missing engine telemetry is itself a coverage failure (engine throw, pre-run failure, or a
  // legacy injected engine). It must never look like affirmative evidence that no check ran.
  const coverageLossEvents = job.engineTelemetry === null
    ? 1
    : (job.engineTelemetry.agent_check_coverage_loss_events ?? 0) + droppedAttempts;
  const incomplete = unparseableLines > 0 || coverageLossEvents > 0;
  return {
    schema_version: 3,
    source: "pi-bash-events",
    state: incomplete
      ? attempts.length === 0 ? "unobservable" : "partial"
      : attempts.length === 0 ? "none" : "attempted",
    unparseable_lines: unparseableLines,
    coverage_loss_events: coverageLossEvents,
    work_id: job.id,
    attempts,
  };
}

function buildResultTelemetry(
  job: Job,
  gitChanged: boolean,
  checkDurationMs?: number
): CodeLoopTelemetry {
  const observed = job.engineTelemetry?.mutation_evidence === "tool-call";
  const mutationEvidence = observed ? "tool-call" : gitChanged ? "diff-only" : "none";
  const firstEditTurn = observed ? job.engineTelemetry?.first_edit_turn : undefined;
  const editStartMs = observed ? job.engineTelemetry?.edit_start_ms : undefined;
  const phase: CodeLoopTelemetry["phase_ms"] = observed
    ? { ...(job.engineTelemetry?.phase_ms ?? {}) }
    : {};
  if (checkDurationMs !== undefined) phase.check = checkDurationMs;
  return {
    schema_version: 1,
    ...(firstEditTurn !== undefined ? { first_edit_turn: firstEditTurn } : {}),
    ...(editStartMs !== undefined ? { edit_start_ms: editStartMs } : {}),
    phase_ms: phase,
    mutation_evidence: mutationEvidence,
    observability_coverage: observed
      ? (job.engineTelemetry?.observability_coverage ?? 1)
      : mutationEvidence === "diff-only"
        ? 0.5
        : 1,
    ...(job.engineTelemetry?.failure_kind !== undefined
      ? { failure_kind: job.engineTelemetry.failure_kind }
      : {}),
  };
}

// ─── git helpers (ground truth for the diff) ────────────────────────────────────────────

const GIT_ENV = { GIT_AUTHOR_NAME: "code-loop", GIT_AUTHOR_EMAIL: "code-loop@local", GIT_COMMITTER_NAME: "code-loop", GIT_COMMITTER_EMAIL: "code-loop@local" };

async function gitInitSeed(sandboxDir: string, deps: CodeLoopDeps): Promise<string> {
  const env = { ...gitBaseEnv(), ...GIT_ENV };
  await deps.runCommand(["git", "init", "-q"], { cwd: sandboxDir, env, timeoutMs: 30_000 });
  await deps.runCommand(["git", "add", "-A"], { cwd: sandboxDir, env, timeoutMs: 30_000 });
  await deps.runCommand(["git", "commit", "-q", "-m", "seed", "--allow-empty"], { cwd: sandboxDir, env, timeoutMs: 30_000 });
  const rev = await deps.runCommand(["git", "rev-parse", "HEAD"], { cwd: sandboxDir, env, timeoutMs: 10_000 });
  return rev.stdout.trim();
}

async function gitHarvest(sandboxDir: string, seedSha: string, deps: CodeLoopDeps): Promise<{ diff: string; changedFiles: string[] }> {
  const env = { ...gitBaseEnv(), ...GIT_ENV };
  await deps.runCommand(["git", "add", "-A"], { cwd: sandboxDir, env, timeoutMs: 30_000 });
  const diffRes = await deps.runCommand(["git", "diff", "--cached", seedSha], { cwd: sandboxDir, env, timeoutMs: 30_000 });
  const namesRes = await deps.runCommand(["git", "diff", "--cached", "--name-only", seedSha], { cwd: sandboxDir, env, timeoutMs: 30_000 });
  const changed = namesRes.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  // Re-validate changed-file paths for containment on the way out (design §5.4).
  const contained = changed.filter((f) => !isAbsolute(f) && !f.split(/[\\/]/).includes(".."));
  return { diff: diffRes.stdout, changedFiles: contained };
}

function gitBaseEnv(): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" };
}

const CHECK_TIMEOUT_MS = 120_000;

async function runCheck(
  checkCmd: string,
  sandboxDir: string,
  cageArgv: string[],
  deps: CodeLoopDeps
): Promise<{ ran: boolean; exit_code: number | null; output_tail: string }> {
  // check_cmd runs INSIDE the same cage with a minimal env (PATH/HOME only — not even HS_API_KEY).
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: sandboxDir };
  const argv = [...cageArgv, "bash", "-c", checkCmd];
  const r = await deps.runCommand(argv, { cwd: sandboxDir, env, timeoutMs: CHECK_TIMEOUT_MS });
  const combined = `${r.stdout}\n${r.stderr}`;
  return { ran: true, exit_code: r.code, output_tail: combined.slice(-4096) };
}

// ─── Finalization + ledger ──────────────────────────────────────────────────────────────

function finalizeJobWithResult(
  job: Job,
  result: CodeLoopResult,
  req: CodeLoopRequest,
  deps: CodeLoopDeps,
  unitName: string
): void {
  job.status = result.status;
  job.result = result;
  job.usage = result.usage;
  writeMeta(job.sandboxDir, {
    work_id: job.id,
    status: result.status,
    scope_unit: unitName,
    model: job.model,
    started_at_ms: job.startedAtMs,
  });
  persistJobDurable(job);
  recordCodeLoopRun(result.status);
  writeLedger(job, result.status, req, deps, result.check);
}

/** Used only for the pre-run lease/spawn refusal (no engine result yet). */
function finalizeJob(
  job: Job,
  status: CodeLoopTerminalStatus,
  detail: string,
  check: { ran: boolean; exit_code: number | null; output_tail: string },
  req: CodeLoopRequest,
  deps: CodeLoopDeps
): void {
  job.status = status;
  job.result = {
    status,
    diff: "",
    diff_truncated: false,
    changed_files: [],
    protected_violations: [],
    summary: "",
    check,
    usage: job.usage,
    execution: codeLoopExecution(job),
    telemetry: buildResultTelemetry(job, false),
    agent_checks: codeLoopAgentChecks(job),
    work_id: job.id,
    detail: detail.slice(0, 400),
  };
  persistJobDurable(job);
  recordCodeLoopRun(status);
  writeLedger(job, status, req, deps, check);
}

function persistJobDurable(job: Job): void {
  try {
    persistDurableCodeLoopRun(job.workroot, {
      schema_version: 1,
      client_run_id: job.durableClientRunId,
      request_fingerprint: job.durableRequestFingerprint,
      work_id: job.id,
      status: job.status,
      usage: job.usage,
      result: job.result,
      started_at_ms: job.startedAtMs,
    });
  } catch (err) {
    console.error("[code-loop] durable idempotency update failed:", err);
  }
}

function writeLedger(
  job: Job,
  status: CodeLoopTerminalStatus,
  req: CodeLoopRequest,
  deps: CodeLoopDeps,
  check: { ran: boolean; exit_code: number | null }
): void {
  const { outcome, errorClass } = ledgerOutcome(status, check);
  try {
    recordDelegation({
      taskType: job.taskType,
      modelId: job.model,
      prompt: req.instruction,
      outcome,
      errorClass,
      latencyMs: job.usage.wall_ms,
      promptTokens: job.usage.prompt_tokens || null,
      completionTokens: job.usage.completion_tokens || null,
      verifier: job.checkCmd !== null ? "check-cmd" : null,
      source: "code-loop",
    });
  } catch (err) {
    // Never let a telemetry write break the run.
    console.error("[code-loop] ledger write failed (ignored):", err);
  }
}

// ─── Read API ───────────────────────────────────────────────────────────────────────────

export function getJobStatus(workId: string, workroot?: string): { status: CodeLoopJobStatus; usage: CodeLoopUsage } | null {
  const job = jobs.get(workId);
  if (job) return { status: job.status, usage: job.usage };
  const durable = workroot === undefined ? null : readDurableCodeLoopRunByWork(workroot, workId);
  return durable === null ? null : { status: durable.status, usage: durable.usage };
}

export type GetResultOutcome =
  | { kind: "unknown" }
  | { kind: "running" }
  | { kind: "terminal-unavailable"; status: CodeLoopTerminalStatus }
  | { kind: "result"; result: CodeLoopResult };

export function getJobResult(workId: string, workroot?: string): GetResultOutcome {
  const job = jobs.get(workId);
  if (job) {
    if (job.result === null) return { kind: "running" };
    return { kind: "result", result: job.result };
  }
  const durable = workroot === undefined ? null : readDurableCodeLoopRunByWork(workroot, workId);
  if (durable === null) return { kind: "unknown" };
  const compatible = workroot === undefined ? durable : failClosedIncompatibleResult(workroot, durable);
  if (compatible.result !== null) return { kind: "result", result: compatible.result };
  if (compatible.status === "running") return { kind: "running" };
  return { kind: "terminal-unavailable", status: compatible.status };
}

// ─── Startup sweep (orphan detection + TTL reclaim, design §5) ──────────────────────────

/**
 * Scan the workroot at gateway startup. Any sandbox with a `.meta.json` status "running" and no
 * live in-memory job is orphaned (a restart killed its process) → best-effort stop its transient
 * scope unit, mark it orphaned. Any sandbox older than the TTL is reclaimed (rm -rf).
 */
export async function sweepCodeLoopSandboxes(
  cfg: { workroot: string; retentionTtlMs: number },
  deps: { now: () => number; stopUnit: (unit: string) => Promise<void> }
): Promise<{ orphaned: number; reclaimed: number }> {
  let orphaned = 0;
  let reclaimed = 0;
  const now = deps.now();
  // Enforce source retention from the trusted caller record even when the sandbox or its
  // agent-writable metadata was deleted/corrupted. This is idempotent and safe to run periodically.
  compactExpiredDurableCodeLoopRuns(cfg.workroot, now, cfg.retentionTtlMs);
  // The process-local table is also source-bearing: terminal Job.result contains the summary and
  // diff. Evict it from the same trusted start timestamp before consulting sandbox metadata, both
  // to enforce the TTL when metadata/the whole sandbox vanished and to bound memory growth.
  const canonicalWorkroot = resolve(cfg.workroot);
  for (const [workId, job] of jobs) {
    if (resolve(job.workroot) === canonicalWorkroot && job.status !== "running" &&
        now - job.startedAtMs > cfg.retentionTtlMs) jobs.delete(workId);
  }
  let entries: string[];
  try {
    entries = readdirSync(cfg.workroot);
  } catch {
    return { orphaned, reclaimed };
  }
  for (const name of entries) {
    const dir = join(cfg.workroot, name);
    const metaPath = join(dir, ".meta.json");
    let meta: MetaRecord | null = null;
    if (existsSync(metaPath)) {
      let metaFd: number | null = null;
      try {
        // Open without following symlinks or blocking on a hostile FIFO, then inspect/read the
        // stable descriptor. The extra byte detects a file that grows past the cap after fstat,
        // closing the lstat/read TOCTOU window against an agent mutating its live sandbox.
        metaFd = openSync(
          metaPath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
        );
        const metaStat = fstatSync(metaFd);
        if (metaStat.isFile() && metaStat.size <= META_MAX_BYTES) {
          const bytes = Buffer.allocUnsafe(META_MAX_BYTES + 1);
          const bytesRead = readSync(metaFd, bytes, 0, bytes.length, 0);
          if (bytesRead <= META_MAX_BYTES) {
            const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as Partial<MetaRecord>;
            if (typeof parsed.work_id === "string" && typeof parsed.status === "string" &&
                typeof parsed.started_at_ms === "number") meta = parsed as MetaRecord;
          }
        }
      } catch {
        /* hostile/partial metadata is never authoritative */
      } finally {
        if (metaFd !== null) closeSync(metaFd);
      }
    }
    const inferredWorkId = /^(cl-\d{8}-[0-9a-f]{8})-/.exec(name)?.[1] ?? null;
    const candidateWorkId = inferredWorkId ?? meta?.work_id ?? null;
    if (candidateWorkId === null) continue;
    let durable = readDurableCodeLoopRunByWork(cfg.workroot, candidateWorkId);
    const workId = durable?.work_id ?? candidateWorkId;
    let status = durable?.status ?? meta?.status ?? null;
    let filesystemStartedAtMs: number | null = null;
    if (durable === null && meta === null && inferredWorkId !== null) {
      try {
        const stat = lstatSync(dir);
        // Never follow or recursively operate through a look-alike symlink/file. A directory
        // mtime is the last-resort trusted age anchor only for a recordless cl-* sandbox.
        if (!stat.isDirectory()) continue;
        filesystemStartedAtMs = stat.mtimeMs;
      } catch {
        continue;
      }
    }
    const startedAtMs = durable?.started_at_ms ?? meta?.started_at_ms ?? filesystemStartedAtMs;

    // Orphan detection is anchored to the deterministic work id + durable process identity, not
    // the mutable metadata. A valid live lease survives rolling gateway overlap.
    if (status === "running" && !jobs.has(workId) && !isDurableCodeLoopWorkLive(cfg.workroot, workId)) {
      const unitName = `code-loop-${workId}`;
      if (isCodeLoopUnitName(unitName)) {
        try {
          await deps.stopUnit(unitName);
        } catch {
          /* unit already gone */
        }
      }
      if (meta !== null) writeMeta(dir, { ...meta, work_id: workId, status: "orphaned" });
      markDurableCodeLoopRunOrphaned(cfg.workroot, workId);
      durable = readDurableCodeLoopRunByWork(cfg.workroot, workId);
      status = durable?.status ?? "orphaned";
      recordCodeLoopRun("orphaned");
      orphaned++;
    }

    // Reclaim only non-running sandboxes. The trusted durable start time wins over any forged
    // `.meta.json`; deleted/garbled metadata therefore cannot extend source retention.
    if (status !== "running" && startedAtMs !== null && now - startedAtMs > cfg.retentionTtlMs) {
      try {
        compactDurableCodeLoopRunResult(cfg.workroot, workId);
        rmSync(dir, { recursive: true, force: true });
        reclaimed++;
      } catch {
        /* next periodic sweep retries */
      }
    }
  }
  // A crash can happen after the caller binding is fsync'd but before sandbox metadata exists.
  // The exact live work-id lease distinguishes those old records from a new start racing this
  // async sweep; PID liveness alone is insufficient because of reuse or a stale same-process row.
  const durableOrphans = markUnownedDurableCodeLoopRunsOrphaned(cfg.workroot, new Set(jobs.keys()));
  for (let i = 0; i < durableOrphans; i++) recordCodeLoopRun("orphaned");
  orphaned += durableOrphans;
  return { orphaned, reclaimed };
}
