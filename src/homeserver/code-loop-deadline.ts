import type { CodeLoopDeps } from "./code-loop-types.js";

/** Leave time for TERM/KILL, repeated exact-unit stop/absence proofs, lease release and
 * finalization. Cleanup must settle before its caller can publish a terminal result.
 */
export const CODE_LOOP_CLEANUP_RESERVE_MS = 75_000;
export const CODE_LOOP_TOTAL_WALL_MIN_S = 90;
export const CODE_LOOP_TOTAL_WALL_MAX_S = 900;

export class CodeLoopDeadlineError extends Error {
  constructor() {
    super("Whole-job work deadline reached; further phases are forbidden.");
  }
}

export class CodeLoopDeadline {
  readonly controller = new AbortController();
  readonly startedAt = performance.now();
  readonly endsAt: number;
  readonly workEndsAt: number;
  transferred = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(readonly totalWallS: number) {
    this.endsAt = this.startedAt + totalWallS * 1000;
    this.workEndsAt = this.endsAt - CODE_LOOP_CLEANUP_RESERVE_MS;
    this.timer = setTimeout(() => this.controller.abort(new CodeLoopDeadlineError()), this.remainingWorkMs());
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get expired(): boolean {
    if (!this.signal.aborted && performance.now() >= this.workEndsAt) {
      this.controller.abort(new CodeLoopDeadlineError());
    }
    return this.signal.aborted;
  }

  remainingWorkMs(): number {
    return Math.max(0, Math.floor(this.workEndsAt - performance.now()));
  }

  assertActive(): void {
    if (this.expired) throw new CodeLoopDeadlineError();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Fence each new phase and cancel resource-owning operations. Do not race their promises:
 * the engine and command executor settle only after their bounded cleanup has completed.
 */
export function withCodeLoopDeadline(deps: CodeLoopDeps, deadline: CodeLoopDeadline): CodeLoopDeps {
  return {
    ...deps,
    ...(deps.beforeModelStart ? {
      beforeModelStart: async (model, options) => {
        deadline.assertActive();
        await deps.beforeModelStart!(model, options);
        deadline.assertActive();
      },
    } : {}),
    ...(deps.codeLoopTransportProbe ? {
      codeLoopTransportProbe: async () => {
        deadline.assertActive();
        const ready = await deps.codeLoopTransportProbe!();
        deadline.assertActive();
        return ready;
      },
    } : {}),
    cageSelfTest: async () => {
      deadline.assertActive();
      const probe = await deps.cageSelfTest(deadline.signal, deadline.remainingWorkMs());
      deadline.assertActive();
      return probe;
    },
    acquireLease: async options => {
      deadline.assertActive();
      const lease = await deps.acquireLease({
        ...options,
        timeoutMs: Math.min(options.timeoutMs, deadline.remainingWorkMs()),
        signal: deadline.signal,
      });
      if (deadline.expired) {
        if (lease) await lease.release();
        throw new CodeLoopDeadlineError();
      }
      return lease;
    },
    engine: {
      // #487: the deadline wraps transport, not capture semantics; keep the engine's capability.
      ...(deps.engine?.supportsContentCaptureSuppression === true ? { supportsContentCaptureSuppression: true } : {}),
      run: async options => {
        deadline.assertActive();
        return deps.engine.run({
          ...options,
          signal: deadline.signal,
          cageArgv: limitCodeLoopCageLifetime(options.cageArgv, deadline.remainingWorkMs()),
          caps: {
            ...options.caps,
            wall_s: Math.min(options.caps.wall_s, Math.max(1, deadline.remainingWorkMs() / 1000)),
          },
        });
      },
    },
    runCommand: async (argv, options) => {
      deadline.assertActive();
      const result = await deps.runCommand(limitCodeLoopCageLifetime(argv, deadline.remainingWorkMs()), {
        ...options,
        signal: deadline.signal,
        timeoutMs: Math.min(options.timeoutMs, deadline.remainingWorkMs()),
      });
      deadline.assertActive();
      return result;
    },
  };
}

/** Tighten systemd's independent cgroup backstop for each invocation. A verifier must not
 * receive the engine's original lifetime after admission and engine time have elapsed.
 */
export function limitCodeLoopCageLifetime(argv: string[], remainingMs: number): string[] {
  if (argv[0] !== "systemd-run") return argv;
  return argv.map((arg, index) => {
    if (argv[index - 1] !== "-p" || !arg.startsWith("RuntimeMaxSec=")) return arg;
    const configured = Number(arg.slice("RuntimeMaxSec=".length));
    return `RuntimeMaxSec=${Math.max(1, Math.min(configured, Math.floor(remainingMs / 1000)))}`;
  });
}
