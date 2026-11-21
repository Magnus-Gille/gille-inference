/**
 * gateway-model-readiness producer journey (INFER-250). No real network: fetch is injected.
 * Pins the closed Heimdall synthetic-journey-outcome v1 shape, the runner-vs-dependency split,
 * the content-free guarantee, and idempotent same-attempt delivery retry.
 */
import { describe, expect, it, vi } from "vitest";
import {
  JOURNEY_ID, STEP_IDS, boundedJson, deliverOutcome, runReadinessAttempt, safeGatewayOrigin, validateOutcome,
  type JourneyOutcome,
} from "../src/homeserver/readiness-journey.js";

const KEY = "monitor-key-SECRET-123";
const BASE = { gatewayUrl: "https://gateway.test:8443", monitorKey: KEY, version: "gille-inference@1.2.3" };

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function clock(step = 10) {
  let t = 1_700_000_000_000;
  return () => { t += step; return t; };
}
function router(map: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const handler = map[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return handler();
  }) as unknown as typeof fetch;
}
const healthy = {
  "/healthz": () => res(200, { ok: true, nodes: [], codeLoopTransport: "disabled" }),
  "/models/residency": () => res(200, { models: [{ model: "private-model-name" }], hostMemory: {}, resourceEvidence: {} }),
};

describe("runReadinessAttempt", () => {
  it("passes only when both declared steps ran in one attempt", async () => {
    const o = await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
    expect(o.outcome).toBe("pass");
    expect(o.runner_outcome).toBe("ok");
    expect(o.journey_id).toBe(JOURNEY_ID);
    expect(o.producer).toBe("gille-inference");
    expect(o.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(o.steps.every((s) => s.outcome === "pass" && s.latency_ms !== null)).toBe(true);
    expect(validateOutcome(o)).toEqual([]);
  });

  it("treats an idle backend (no resident models) as ready", async () => {
    const o = await runReadinessAttempt({
      ...BASE, now: clock(),
      fetchFn: router({ ...healthy, "/models/residency": () => res(200, { models: [] }) }),
    });
    expect(o.outcome).toBe("pass");
  });

  it("treats a rejected monitor key (on either route) as a runner failure, not a dependency failure", async () => {
    for (const route of ["/healthz", "/models/residency"]) {
      const o = await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router({ ...healthy, [route]: () => res(401, {}) }) });
      expect(o.outcome).toBe("unknown");
      expect(o.runner_outcome).toBe("failed");
      expect(o.error_class).toBe("runner-auth");
      expect(o.steps.every((s) => s.outcome === "skipped")).toBe(true);
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("reports a failing gateway (5xx) as a dependency failure and skips the model step", async () => {
    const o = await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router({ ...healthy, "/healthz": () => res(502, {}) }) });
    expect(o.outcome).toBe("fail");
    expect(o.runner_outcome).toBe("ok");
    expect(o.error_class).toBe("dependency-http");
    expect(o.steps[1]).toMatchObject({ id: "model-readiness", outcome: "skipped", error_class: "blocked-by-gateway" });
    expect(validateOutcome(o)).toEqual([]);
  });

  it("reports an unavailable model backend (503) as a model-step failure, gateway step stays green", async () => {
    const o = await runReadinessAttempt({
      ...BASE, now: clock(),
      fetchFn: router({ ...healthy, "/models/residency": () => res(503, { status: "unavailable", resourceEvidence: {} }) }),
    });
    expect(o.outcome).toBe("fail");
    expect(o.error_class).toBe("backend-unavailable");
    expect(o.steps[0]!.outcome).toBe("pass");
    expect(o.steps[1]).toMatchObject({ outcome: "fail", error_class: "backend-unavailable" });
    expect(validateOutcome(o)).toEqual([]);
  });

  it("classifies a timeout", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const o = await runReadinessAttempt({
      ...BASE, now: clock(),
      fetchFn: (async () => { throw timeout; }) as unknown as typeof fetch,
    });
    expect(o.outcome).toBe("fail");
    expect(o.error_class).toBe("timeout");
  });

  it("classifies a connection failure as dependency-network", async () => {
    const o = await runReadinessAttempt({
      ...BASE, now: clock(),
      fetchFn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    });
    expect(o.error_class).toBe("dependency-network");
  });

  it("rejects a malformed healthz body instead of passing", async () => {
    const o = await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router({ ...healthy, "/healthz": () => res(200, { ok: false }) }) });
    expect(o.outcome).toBe("fail");
    expect(o.error_class).toBe("invalid-response");
  });

  it("rejects residency without a models array (never a pass)", async () => {
    const o = await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router({ ...healthy, "/models/residency": () => res(200, {}) }) });
    expect(o.outcome).toBe("fail");
  });

  it("keeps runner failure distinct: missing key or URL is runner-failed/unknown, not a dependency fail", async () => {
    for (const bad of [{ monitorKey: undefined }, { gatewayUrl: undefined }, { gatewayUrl: "ftp://x" }]) {
      const fetchFn = vi.fn() as unknown as typeof fetch;
      const o = await runReadinessAttempt({ ...BASE, ...bad, now: clock(), fetchFn });
      expect(o.runner_outcome).toBe("failed");
      expect(o.outcome).toBe("unknown");
      expect(o.error_class).toBe("runner-config");
      expect(o.steps.every((s) => s.outcome === "skipped")).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("is content-free: no key, model name or response body appears in the outcome", async () => {
    const o = await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
    const text = JSON.stringify(o);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("private-model-name");
    expect(text).not.toContain("gateway.test");
    expect(Object.keys(o).sort()).toEqual([
      "attempt_id", "error_class", "extensions", "journey_id", "kind", "latency_ms", "max_age_seconds",
      "observed_at", "outcome", "producer", "runner_outcome", "schema_version", "started_at", "steps",
      "trace_id", "version",
    ]);
  });

  it("sends the monitor key only as a Bearer header to /models/residency, never to public /healthz", async () => {
    const fetchFn = router(healthy) as unknown as ReturnType<typeof vi.fn>;
    await runReadinessAttempt({ ...BASE, now: clock(), fetchFn: fetchFn as unknown as typeof fetch });
    const calls = fetchFn.mock.calls as [string, RequestInit][];
    expect(calls.map(([u]) => new URL(String(u)).pathname)).toEqual(["/healthz", "/models/residency"]);
    for (const [, init] of calls) expect(init.method).toBe("GET");
    expect((calls[0]![1].headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect((calls[1]![1].headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("refuses a plain-http non-loopback or userinfo gateway URL before sending the key (INFER-517)", async () => {
    for (const gatewayUrl of [
      "http://gateway.test:8080",
      "http://10.0.0.5:8080",
      "http://127.0.0.1.example:8080",
      "https://user:pass@gateway.test",
    ]) {
      const fetchFn = vi.fn() as unknown as typeof fetch;
      const o = await runReadinessAttempt({ ...BASE, gatewayUrl, now: clock(), fetchFn });
      expect(o.runner_outcome).toBe("failed");
      expect(o.error_class).toBe("runner-config");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("allows plain http only to a loopback gateway", async () => {
    expect(safeGatewayOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(safeGatewayOrigin("http://localhost:8080/ignored")).toBe("http://localhost:8080");
    expect(safeGatewayOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(safeGatewayOrigin("https://gateway.test")).toBe("https://gateway.test");
    expect(safeGatewayOrigin("http://gateway.test")).toBeNull();
    expect(safeGatewayOrigin(undefined)).toBeNull();
    const o = await runReadinessAttempt({ ...BASE, gatewayUrl: "http://127.0.0.1:8080", now: clock(), fetchFn: router(healthy) });
    expect(o.outcome).toBe("pass");
  });

  it("classifies an oversized residency body as invalid-response", async () => {
    const big = JSON.stringify({ models: [], pad: "x".repeat(70 * 1024) });
    const o = await runReadinessAttempt({
      ...BASE, now: clock(),
      fetchFn: router({ ...healthy, "/models/residency": () => new Response(big, { status: 200 }) }),
    });
    expect(o.outcome).toBe("fail");
    expect(o.error_class).toBe("invalid-response");
  });
});

describe("boundedJson", () => {
  function streamOf(chunks: number, chunkBytes: number, onPull: () => void): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull();
        if (sent >= chunks) { controller.close(); return; }
        sent += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
    });
  }

  it("stops reading once the stream passes the bound instead of buffering the whole body", async () => {
    let pulls = 0;
    const body = streamOf(1000, 16 * 1024, () => { pulls += 1; });
    await expect(boundedJson(new Response(body), 64 * 1024)).rejects.toMatchObject({ name: "ResponseTooLarge" });
    expect(pulls).toBeLessThan(10);
  });

  it("refuses a declared Content-Length over the bound without reading the body", async () => {
    let pulls = 0;
    const body = streamOf(1, 10, () => { pulls += 1; });
    const r = new Response(body, { headers: { "content-length": String(1024 * 1024) } });
    await expect(boundedJson(r, 64 * 1024)).rejects.toMatchObject({ name: "ResponseTooLarge" });
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("parses a body within the bound and returns null for non-JSON", async () => {
    expect(await boundedJson(new Response(JSON.stringify({ ok: true })))).toEqual({ ok: true });
    expect(await boundedJson(new Response("not json"))).toBeNull();
    expect(await boundedJson(new Response(null))).toBeNull();
  });
});

describe("validateOutcome", () => {
  async function good(): Promise<JourneyOutcome> {
    return runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
  }
  it("refuses a pass with a missing step (partial evidence never passes)", async () => {
    const o = await good();
    o.steps = o.steps.slice(0, 1);
    expect(validateOutcome(o)).toContain("pass-consistency");
  });
  it("refuses a pass with a skipped step", async () => {
    const o = await good();
    o.steps[1] = { ...o.steps[1]!, outcome: "skipped", latency_ms: null };
    expect(validateOutcome(o)).toContain("pass-consistency");
  });
  it("refuses unknown/duplicate step ids and unsafe attempt ids", async () => {
    const o = await good();
    (o.steps[1] as { id: string }).id = "gateway-readiness";
    o.attempt_id = "has spaces";
    const errors = validateOutcome(o);
    expect(errors).toContain("step-id");
    expect(errors).toContain("attempt");
  });
});

describe("deliverOutcome", () => {
  const URL_ = "https://heimdall.test/api/synthetic-journeys";
  const TOKEN = "journey-token-SECRET";
  async function outcome() {
    return runReadinessAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
  }

  it("POSTs the document with the dedicated Bearer and reports delivered", async () => {
    const o = await outcome();
    const fetchFn = vi.fn(async () => res(200, { ok: true })) as unknown as typeof fetch;
    const r = await deliverOutcome(o, { url: URL_, token: TOKEN, fetchFn, sleep: async () => {} });
    expect(r).toEqual({ delivered: true, attempts: 1, status: 200 });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual(o);
  });

  it("retries transport errors and 5xx with the identical attempt document", async () => {
    const o = await outcome();
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(res(502, {}))
      .mockResolvedValueOnce(res(200, { ok: true, replay: true })) as unknown as typeof fetch;
    const r = await deliverOutcome(o, { url: URL_, token: TOKEN, fetchFn, sleep: async () => {} });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(3);
    const bodies = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, i]) => (i as RequestInit).body);
    expect(new Set(bodies).size).toBe(1);
  });

  it("does not retry a 4xx and surfaces it as rejected, never leaking token or payload", async () => {
    const o = await outcome();
    const fetchFn = vi.fn(async () => res(409, { error: "replay" })) as unknown as typeof fetch;
    const r = await deliverOutcome(o, { url: URL_, token: TOKEN, fetchFn, sleep: async () => {} });
    expect(r).toEqual({ delivered: false, attempts: 1, status: 409, error: "delivery-rejected" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("gives up visibly after exhausting retries", async () => {
    const o = await outcome();
    const fetchFn = vi.fn(async () => { throw new TypeError("down"); }) as unknown as typeof fetch;
    const r = await deliverOutcome(o, { url: URL_, token: TOKEN, fetchFn, sleep: async () => {} });
    expect(r).toEqual({ delivered: false, attempts: 3, error: "delivery-transport" });
  });

  it("refuses plain-http (non-loopback) and wrong-path delivery URLs before sending the token", async () => {
    const o = await outcome();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    for (const url of ["http://heimdall.test/api/synthetic-journeys", "https://heimdall.test/api/other", "https://u:p@heimdall.test/api/synthetic-journeys", "https://heimdall.test/api/synthetic-journeys?x=1"]) {
      expect((await deliverOutcome(o, { url, token: TOKEN, fetchFn })).error).toBe("delivery-config");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails closed without URL/token and never posts an invalid document", async () => {
    const o = await outcome();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect((await deliverOutcome(o, { url: undefined, token: TOKEN, fetchFn })).error).toBe("delivery-config");
    expect((await deliverOutcome(o, { url: URL_, token: undefined, fetchFn })).error).toBe("delivery-config");
    const broken = { ...o, steps: [] };
    expect((await deliverOutcome(broken, { url: URL_, token: TOKEN, fetchFn })).error).toBe("invalid-outcome");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
