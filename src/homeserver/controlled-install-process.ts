/** Local POSIX foreground process adapter. Not a sandbox; service managers require a cgroup adapter. */
import { spawn } from "node:child_process";

export interface InstallProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  /** Explicit allowlist, never process.env. No secrets in args, environment, or output. */
  env: NodeJS.ProcessEnv;
  termGraceMs: number;
}

/**
 * One-shot, owned process group. Normal exit still requires stop() to prove descendants are gone.
 * Only for cooperative foreground commands: daemonizing/setsid/systemd work needs unit containment.
 */
export function createInstallProcess(options: InstallProcessOptions): {
  run(signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
} {
  if (process.platform === "win32") throw new Error("POSIX process groups required");
  if (!Number.isSafeInteger(options.termGraceMs) || options.termGraceMs < 1 || options.termGraceMs > 60_000) {
    throw new Error("invalid termination grace");
  }
  let pid: number | undefined;
  let started = false;
  let escalation: NodeJS.Timeout | undefined;
  let groupError = false;
  function send(signal: NodeJS.Signals | 0): boolean {
    if (pid === undefined) return false;
    try { process.kill(-pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") { pid = undefined; return false; }
      groupError = true;
      return true; // Unknown is not proof of absence.
    }
  }
  function terminate(): void {
    if (!send("SIGTERM") || escalation) return;
    escalation = setTimeout(() => { send("SIGKILL"); }, options.termGraceMs);
  }
  return {
    run(signal) {
      if (started) return Promise.reject(new Error("install process is one-shot"));
      started = true;
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const child = spawn(options.executable, options.args, {
          cwd: options.cwd, env: options.env, detached: true, stdio: "ignore", shell: false,
        });
        pid = child.pid;
        const abort = (): void => terminate();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const detach = (): void => signal.removeEventListener("abort", abort);
        child.once("error", () => { detach(); reject(new Error("install process spawn failed")); });
        child.once("exit", code => {
          detach();
          // Do not clear escalation on parent exit; grandchildren may ignore TERM.
          if (code === 0 && !signal.aborted) resolve();
          else reject(new Error("install process failed or cancelled"));
        });
      });
    },
    async stop(signal) {
      signal.throwIfAborted();
      terminate();
      try {
        while (send(0)) {
          signal.throwIfAborted();
          // A dying/orphaned group can temporarily be unobservable (notably on macOS).
          // Keep polling within the caller's deadline; only ESRCH proves absence.
          await new Promise<void>(resolve => {
            const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
            const timer = setTimeout(finish, 20);
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted) finish();
          });
        }
        signal.throwIfAborted();
      } finally {
        if (escalation) clearTimeout(escalation);
        // If proof times out, still request KILL but report failure; never claim restoration.
        if (signal.aborted || groupError) send("SIGKILL");
      }
    },
  };
}
