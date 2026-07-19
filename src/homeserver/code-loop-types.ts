import type {
  HuginRequestStamp,
  LearningTaskCapabilityEpoch,
  LearningTaskGatewayEcho,
} from "./learning-task-contract.js";

/**
 * code_loop — frozen type contract (issue #116, docs/agentic-code-tool-design.md).
 *
 * Owner-only sandboxed pi-driven agentic coding tool on the M5: three MCP tools
 * (code_loop_start / code_loop_status / code_loop_result) manage an ASYNC job that wraps a
 * pi subprocess inside an OS cage, pointed back at the gateway's own /v1. The caller seeds a
 * throwaway sandbox with inline files, the run is capped (wall/turns/tokens/growth), and the
 * deliverable is a git diff vs the seed commit — the box never mutates a live checkout.
 */

// ─── Request / caps ─────────────────────────────────────────────────────────────────────

export interface CodeLoopSeedFile {
  /** Relative path inside the sandbox. Validated (lexical + realpath + wx) before any write. */
  path: string;
  content: string;
}

/** Caller-supplied caps; every field optional, clamped to the configured hard maxima. */
export interface CodeLoopCapsRequest {
  wall_s?: number;
  turns?: number;
  completion_tokens?: number;
  /** Optional first-mutation deadline. Strictly validated; never silently clamped. */
  edit_deadline_turn?: number;
}

/** Effective caps after clamping — always fully populated. */
export interface CodeLoopCaps {
  wall_s: number;
  turns: number;
  completion_tokens: number;
  /** Omitted preserves the pre-#247 harness behavior byte-for-byte. */
  edit_deadline_turn?: number;
}

/** Defaults + hard maxima from HomeserverConfig (env-driven; design §7). */
export interface CodeLoopCapsConfig {
  wallSDefault: number;
  wallSMax: number;
  turnsDefault: number;
  turnsMax: number;
  tokensDefault: number;
  tokensMax: number;
}

export interface CodeLoopRequest {
  /** Optional durable idempotency key. Same id + same canonical request returns the same run. */
  client_run_id?: string;
  /** Optional dual-read LearningTaskContract v1 stamp; validated before any new admission. */
  learning_task_stamp?: HuginRequestStamp;
  /** The task prompt (required). */
  instruction: string;
  /** Phase-1 seeding: inline file subset (required, ≤64 files / ≤2 MB total, relative paths). */
  files: CodeLoopSeedFile[];
  /** Owner-authored verification command, run in the sandbox INSIDE the cage post-loop (120 s cap). */
  check_cmd?: string;
  /** Globs whose modification is detected at exit and reported — never silently passed. */
  protected?: string[];
  /** Ledger task type; defaults to the classifier's verdict on the instruction. */
  task_type?: string;
  caps?: CodeLoopCapsRequest;
}

// ─── Statuses ───────────────────────────────────────────────────────────────────────────

/** Immediate structured refusals from code_loop_start (design §4). */
export type CodeLoopRefusal =
  | "disabled"
  | "busy"
  | "maintenance"
  | "lease-unavailable"
  | "cage-unavailable"
  | "invalid-request"
  | "conflict"
  | "admission-recovery";

/** Terminal run statuses. `status` describes the RUN; verification lives in `check` —
 *  there is deliberately no "pass" status (design §4). */
export type CodeLoopTerminalStatus = "completed" | "cap-exceeded" | "degenerate" | "arm-error" | "orphaned";

export type CodeLoopJobStatus = "running" | CodeLoopTerminalStatus;

export interface CodeLoopUsage {
  turns: number;
  wall_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CodeLoopCheck {
  ran: boolean;
  exit_code: number | null;
  /** Last 4 KB of the check command's combined output. */
  output_tail: string;
}

export interface CodeLoopExecution {
  schema_version: 1;
  model: string;
  engine: "pi";
  /** Immutable harness contract identifier, not a mutable deployment label. */
  harness_version: string;
  effective_caps: CodeLoopCaps;
  capabilities: {
    start_idempotency: "client-run-id-v1";
    agent_checks: "pi-bash-events-v3";
  };
}

export type CodeLoopAgentCheckKind = "typescript" | "test" | "lint" | "build" | "validation";
export type CodeLoopAgentCheckStatus = "passed" | "failed" | "execution-error";
/** Shared producer/consumer bound for the immutable v3 attempt array. */
export const CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX = 1_000;

/** Immutable content-blind evidence derived from actual pi bash tool events, never prose. */
export interface CodeLoopAgentCheckAttempt {
  order: number;
  kind: CodeLoopAgentCheckKind;
  command_fingerprint: string;
  started_ms: number;
  ended_ms: number;
  status: CodeLoopAgentCheckStatus;
  exit_code: number | null;
}

export interface CodeLoopAgentChecks {
  schema_version: 3;
  source: "pi-bash-events";
  /** `unobservable`/`partial` fail attribution safely when event coverage was incomplete. */
  state: "none" | "attempted" | "unobservable" | "partial";
  unparseable_lines: number;
  /** Count only: refused candidate commands or uncorrelated bash events; never command content. */
  coverage_loss_events: number;
  work_id: string;
  attempts: CodeLoopAgentCheckAttempt[];
}

export type CodeLoopMutationEvidence = "tool-call" | "diff-only" | "none";

export interface CodeLoopTelemetry {
  schema_version: 1;
  /** Present only when a completed edit/write tool call was observed. */
  first_edit_turn?: number;
  /** Milliseconds from the first engine attempt to that observed mutation. */
  edit_start_ms?: number;
  phase_ms: {
    /** Engine start to first observed edit/write completion. */
    inspect?: number;
    /** First observed edit/write completion to agent exit. */
    edit?: number;
    /** M5-side owner check_cmd only; external Gate D verification is separate. */
    check?: number;
  };
  mutation_evidence: CodeLoopMutationEvidence;
  /** 1 = event stream and git agree; 0.5 = git proves a diff but no trusted mutation event. */
  observability_coverage: number;
  failure_kind?: "edit-deadline";
}

export interface CodeLoopResult {
  status: CodeLoopTerminalStatus;
  /** Unified git diff vs the seed commit, ≤200 KB (see diff_truncated). Ground truth is git. */
  diff: string;
  diff_truncated: boolean;
  changed_files: string[];
  protected_violations: string[];
  /** pi's final assistant message (≤2 KB). */
  summary: string;
  check: CodeLoopCheck;
  usage: CodeLoopUsage;
  /** Additive #247 fields: immutable effective execution plus content-blind phase evidence. */
  execution: CodeLoopExecution;
  telemetry: CodeLoopTelemetry;
  /** Agent-side checks only. Gateway check_cmd remains the separate `check` field above. */
  agent_checks: CodeLoopAgentChecks;
  work_id: string;
  /**
   * Human-readable failure detail for non-completed statuses (spawn error / stderr tail /
   * which cap, ≤400 chars; "" on a clean completion). Without it an arm-error is a blank
   * result the caller can only diagnose with a manual sandbox dig (live smoke, 2026-07-02).
   */
  detail: string;
}

export type CodeLoopStartResult =
  | {
      ok: true;
      work_id: string;
      status: CodeLoopJobStatus;
      client_run_id: string | null;
      request_fingerprint: string | null;
      recovered: boolean;
      /** Exact immutable echo for stamped starts; absent on the declared legacy path. */
      learning_task_gateway_echo?: LearningTaskGatewayEcho;
      result?: CodeLoopResult;
      capabilities: {
        start_idempotency: "client-run-id-v1";
        agent_checks: "pi-bash-events-v3";
      };
    }
  | {
      ok: false;
      refusal: CodeLoopRefusal;
      message: string;
      /** Present only when an exact admission exists but its durable work record does not. */
      recovered_admission?: true;
      learning_task_gateway_echo?: LearningTaskGatewayEcho;
    };

// ─── Engine seam (pi is the only Phase-1 implementation; native A/B is Later) ───────────

export type EngineOutcome = "completed" | "cap-exceeded" | "degenerate" | "arm-error";

export interface EngineRunOptions {
  sandboxDir: string;
  instruction: string;
  model: string;
  caps: CodeLoopCaps;
  /** Cage argv prefix ([] when confinement is off — offline tests only). */
  cageArgv: string[];
  /** Sandbox growth cap (bytes); breach aborts the run as cap-exceeded. */
  growthCapBytes: number;
}

export interface EngineRunResult {
  outcome: EngineOutcome;
  usage: CodeLoopUsage;
  /** Final assistant message text ("" if none was seen). */
  finalMessage: string;
  /** NDJSON hygiene: unparseable stdout lines are tolerated + counted, never fatal. */
  unparseableLines: number;
  /** Human-readable detail for non-completed outcomes (which cap, exit code, …). */
  detail: string;
  /** Optional for injected legacy test engines; the real pi engine always supplies it. */
  telemetry?: {
    first_edit_turn?: number;
    edit_start_ms?: number;
    phase_ms: { inspect?: number; edit?: number };
    mutation_evidence: "tool-call" | "none";
    observability_coverage: number;
    failure_kind?: "edit-deadline";
    agent_checks?: Array<{
      order: number;
      kind: CodeLoopAgentCheckKind;
      command_fingerprint: string;
      started_ms: number;
      ended_ms: number;
      status: CodeLoopAgentCheckStatus;
      exit_code: number | null;
    }>;
    /** Content-blind NDJSON coverage signal for agent-check attribution v3. */
    agent_check_unparseable_lines?: number;
    /** Content-blind count of refused check candidates / uncorrelated bash events. */
    agent_check_coverage_loss_events?: number;
  };
}

export interface AgentEngine {
  run(opts: EngineRunOptions): Promise<EngineRunResult>;
}

// ─── DI seams (fake spawn + scripted probes in offline tests) ───────────────────────────

/** Minimal child-process surface the engine needs; the real impl wraps node:child_process. */
export interface PiProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  /** Kill the PROCESS GROUP (SIGTERM, then SIGKILL escalation is the caller's job). */
  kill(signal: NodeJS.Signals): void;
  /** Resolves with the exit code (null when signal-killed). Never rejects. */
  exited: Promise<number | null>;
  pid: number | undefined;
}

export type SpawnPiFn = (argv: string[], opts: { cwd: string; env: Record<string, string> }) => PiProcess;

export interface CodeLoopDeps {
  /** The agent engine (pi in Phase 1). Injected so offline tests can supply a fake. */
  engine: AgentEngine;
  spawnPi: SpawnPiFn;
  now: () => number;
  /** Authenticated transport facts injected by the gateway, never accepted from the JSON body. */
  learningTaskAdmission?: {
    capabilityEpoch: LearningTaskCapabilityEpoch;
    authenticatedPrincipalId: string;
    authentication: "gateway-owner-auth" | "service-auth";
    gatewayRequestId: string;
  };
  /** Authenticated key alias persisted on the derived capability-ledger row. */
  keyAlias?: string | null;
  /** Poll gateway/model readiness after a suspected degeneracy abort; resolves ready?. */
  readinessProbe: (timeoutMs: number) => Promise<boolean>;
  /** The cage self-test (design §6); consulted at every job start when confinement=required. */
  cageSelfTest: () => Promise<{ ok: boolean; failures: string[] }>;
  /** Live maintenance-mode flag (the model-scout window). */
  maintenanceMode: () => boolean;
  /** Acquire the GPU lease (60 s budget); null ⇒ refuse the job (lease-unavailable). */
  acquireLease: (opts: {
    model: string;
    timeoutMs: number;
    onLeaseLost: () => void;
  }) => Promise<{ release: () => Promise<void> } | null>;
  /** Run a host-side command (git harvest, caged check_cmd). Never throws; returns code null on timeout. */
  runCommand: (
    argv: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number }
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Sandbox growth cap (bytes). Default 50 MB; overridable for tests. */
  growthCapBytes: number;
  /** Growth/caps poll cadence (ms). Default 5000; small in tests. */
  pollMs: number;
  /** Sandbox retention TTL (ms). Default 24 h. */
  retentionTtlMs: number;
  /** Test seam for pre-engine metadata I/O; failures are deliberately best-effort. */
  writeMeta?: (path: string, content: string) => void;
}
