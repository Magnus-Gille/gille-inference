export interface MaintenanceWindowClientPlan {
  baseUrl: string;
  ttlSeconds: number;
  drainTimeoutSeconds: number;
  command: string[];
}

export interface MaintenanceWindowClientEvidence {
  mode: "exclusive";
  startedAt: string;
  endedAt: string;
  childExitCode: number;
  restored: true;
  runningModels: Array<{ model: string; state: string; ttlSeconds: number | null }>;
}

export interface MaintenanceWindowOpeningEvidence {
  mode: "exclusive";
  startedAt: string;
  runningModels: Array<{ model: string; state: string; ttlSeconds: number | null }>;
}

interface OpenResponse {
  token: string;
  evidence: MaintenanceWindowOpeningEvidence;
}

export interface MaintenanceWindowClientDependencies {
  fetch: typeof fetch;
  apiKey: string;
  runChild(command: string[], opened: MaintenanceWindowOpeningEvidence): Promise<number>;
  now?: () => number;
}

/** The one credential introduced by this wrapper must never be inherited by the child command. */
export function childEnvironmentWithoutMaintenanceKey(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment["M5_MAINTENANCE_KEY"];
  return childEnvironment;
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/admin/maintenance/window`;
}

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null &&
      typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${message}`);
  }
  return body;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

/**
 * Runs one local command inside a server-owned exclusion window. The child inherits exactly the
 * caller's authority; only the admission/lease lifecycle is remote. The opaque release token is
 * held in memory and omitted from returned evidence.
 */
export async function runMaintenanceWindowCommand(
  plan: MaintenanceWindowClientPlan,
  deps: MaintenanceWindowClientDependencies,
): Promise<MaintenanceWindowClientEvidence> {
  if (deps.apiKey.length === 0) throw new Error("M5_MAINTENANCE_KEY is required");
  if (plan.command.length === 0) throw new Error("a command is required after --");
  const url = endpoint(plan.baseUrl);
  const openedBody = await parseJsonResponse(
    await deps.fetch(url, {
      method: "POST",
      headers: authHeaders(deps.apiKey),
      body: JSON.stringify({
        action: "open",
        ttlSeconds: plan.ttlSeconds,
        drainTimeoutSeconds: plan.drainTimeoutSeconds,
      }),
    }),
    "opening exclusive maintenance window",
  ) as Partial<OpenResponse>;
  if (typeof openedBody?.token !== "string" || openedBody.token.length === 0) {
    throw new Error("gateway returned a malformed maintenance-window response");
  }

  let childExitCode = 1;
  let childError: unknown;
  try {
    if (openedBody.evidence?.mode !== "exclusive" || !Array.isArray(openedBody.evidence.runningModels)) {
      throw new Error("gateway returned malformed maintenance-window evidence");
    }
    childExitCode = await deps.runChild(plan.command, openedBody.evidence);
  } catch (error) {
    childError = error;
  } finally {
    await parseJsonResponse(
      await deps.fetch(url, {
        method: "POST",
        headers: authHeaders(deps.apiKey),
        body: JSON.stringify({ action: "close", token: openedBody.token }),
      }),
      "restoring exclusive maintenance window",
    );
    const status = await parseJsonResponse(
      await deps.fetch(url, { method: "GET", headers: authHeaders(deps.apiKey) }),
      "verifying maintenance-window restore",
    ) as { active?: unknown };
    if (status.active !== false) throw new Error("gateway did not verify maintenance-window restore");
  }
  if (childError !== undefined) throw childError;
  const endedAt = new Date((deps.now ?? Date.now)()).toISOString();
  return {
    mode: "exclusive",
    startedAt: openedBody.evidence!.startedAt,
    endedAt,
    childExitCode,
    restored: true,
    runningModels: openedBody.evidence!.runningModels,
  };
}

export function parseMaintenanceWindowArgs(argv: string[]): MaintenanceWindowClientPlan & { evidencePath?: string } {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("usage: maintenance-window [--base-url URL] [--ttl-seconds N] [--drain-timeout-seconds N] [--evidence FILE] -- command ...");
  }
  const flags = argv.slice(0, separator);
  const value = (name: string): string | undefined => {
    const index = flags.indexOf(name);
    if (index < 0) return undefined;
    const result = flags[index + 1];
    if (result === undefined || result.startsWith("--")) throw new Error(`${name} requires a value`);
    return result;
  };
  const known = new Set(["--base-url", "--ttl-seconds", "--drain-timeout-seconds", "--evidence"]);
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i += 2) {
    if (!known.has(flags[i]!)) throw new Error(`unknown maintenance-window flag: ${flags[i]}`);
    if (seen.has(flags[i]!)) throw new Error(`duplicate maintenance-window flag: ${flags[i]}`);
    seen.add(flags[i]!);
    if (flags[i + 1] === undefined) throw new Error(`${flags[i]} requires a value`);
  }
  const parseBounded = (name: string, raw: string | undefined, fallback: number, max: number): number => {
    const number = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(number) || number <= 0 || number > max) {
      throw new Error(`${name} must be greater than zero and at most ${max}`);
    }
    return number;
  };
  const rawBaseUrl = value("--base-url") ?? "http://127.0.0.1:8080";
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("--base-url must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username !== "" ||
    baseUrl.password !== "" || (baseUrl.pathname !== "" && baseUrl.pathname !== "/") ||
    baseUrl.search !== "" || baseUrl.hash !== ""
  ) {
    throw new Error("--base-url must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return {
    baseUrl: baseUrl.origin,
    ttlSeconds: parseBounded("--ttl-seconds", value("--ttl-seconds"), 3_600, 86_400),
    drainTimeoutSeconds: parseBounded("--drain-timeout-seconds", value("--drain-timeout-seconds"), 60, 600),
    evidencePath: value("--evidence"),
    command: argv.slice(separator + 1),
  };
}
