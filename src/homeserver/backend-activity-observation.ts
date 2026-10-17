/** Bounded, read-only direct-runtime scheduler observations. Never whole-host idle evidence. */
import { z } from "zod";
import { parseLlamaCppActivityMetrics } from "./backend-activity-metrics.js";

const targetSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  // Literal loopback only: no DNS, auth, redirects, proxy model routes or query-triggered loads.
  url: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/metrics$/)
    .refine(value => { try { return Number(new URL(value).port) <= 65535; } catch { return false; } }),
}).strict();
export type BackendActivityTarget = z.infer<typeof targetSchema>;
export function validateBackendTargets(input: unknown): BackendActivityTarget[] {
  const result = z.array(targetSchema).max(16).safeParse(input);
  if (!result.success || new Set(result.data.map(t => t.id)).size !== result.data.length ||
      new Set(result.data.map(t => t.url)).size !== result.data.length) throw new Error("invalid backend targets");
  return result.data;
}
type Counts = ReturnType<typeof parseLlamaCppActivityMetrics>;
export interface BackendActivityObservation {
  id: string;
  source: "llamacpp-metrics-v1";
  startedAt: string;
  completedAt: string;
  state: Counts["state"];
  active: number | null;
  queued: number | null;
  reason: Counts["reason"] | "timeout" | "http-error" | "request-failed";
}
export interface BackendActivityReport {
  scope: "configured-runtime-schedulers";
  coverage: "unknown";
  targets: BackendActivityObservation[];
}
const maxBytes = 128 * 1024;
const unknown = (reason: BackendActivityObservation["reason"]) => ({ state: "unknown" as const, active: null, queued: null, reason });

/** Configured ports must be verified as direct runtimes by the operator; URL syntax cannot prove identity. */
export async function observeBackendActivity(
  input: unknown, opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<BackendActivityReport> {
  const targets = validateBackendTargets(input);
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("invalid observation timeout");
  const fetcher = opts.fetch ?? fetch;
  const observations = await Promise.all(targets.map(async target => {
    const startedAt = new Date().toISOString();
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ReturnType<typeof unknown>>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve(unknown("timeout")); }, timeoutMs);
    });
    const request = async (): Promise<Counts | ReturnType<typeof unknown>> => {
      try {
        const response = await fetcher(target.url, { method: "GET", redirect: "error", credentials: "omit", signal: abort.signal });
        if (abort.signal.aborted) { void response.body?.cancel().catch(() => {}); return unknown("timeout"); }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return unknown("http-error"); }
        if (!response.body) return unknown("missing-metrics");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) return unknown("body-too-large");
          chunks.push(part.value);
        }
        return parseLlamaCppActivityMetrics(Buffer.concat(chunks, size).toString("utf8"));
      } catch { return unknown(abort.signal.aborted ? "timeout" : "request-failed"); }
    };
    try {
      const counts = await Promise.race([request(), deadline]);
      return { id: target.id, source: "llamacpp-metrics-v1" as const, startedAt, completedAt: new Date().toISOString(), ...counts };
    } finally {
      clearTimeout(timer);
      abort.abort();
      // Do not let a stalled stream's cancellation delay the observation's deadline.
      void reader?.cancel().catch(() => {});
    }
  }));
  return { scope: "configured-runtime-schedulers", coverage: "unknown", targets: observations };
}
