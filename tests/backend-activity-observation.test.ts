import { describe, it, expect, vi } from "vitest";
import { observeBackendActivity, validateBackendTargets } from "../src/homeserver/backend-activity-observation.js";

const target = { id: "runtime-a", url: "http://127.0.0.1:8081/metrics" };
const metrics = "# TYPE llamacpp:requests_processing gauge\nllamacpp:requests_processing 2\n# TYPE llamacpp:requests_deferred gauge\nllamacpp:requests_deferred 1\n";
const mockFetch = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;

describe("direct backend activity observations", () => {
  it("reports scheduler counts with source, timing and explicitly unknown host coverage", async () => {
    const fetcher = mockFetch(new Response(metrics));
    const result = await observeBackendActivity([target], { fetch: fetcher });
    expect(result).toMatchObject({ coverage: "unknown", scope: "configured-runtime-schedulers", targets: [
      { id: "runtime-a", source: "llamacpp-metrics-v1", state: "observed", active: 2, queued: 1, reason: "ok" },
    ] });
    expect(Number.isFinite(Date.parse(result.targets[0]!.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(result.targets[0]!.completedAt))).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(target.url, expect.objectContaining({ redirect: "error", credentials: "omit" }));
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("does not infer host idle from zero configured targets", async () => {
    expect(await observeBackendActivity([])).toEqual({ coverage: "unknown", scope: "configured-runtime-schedulers", targets: [] });
  });

  it.each([
    "http://example.com:8081/metrics", "http://localhost:8081/metrics", "http://127.1:8081/metrics",
    "http://127.0.0.1:8081/upstream/model/metrics", "http://127.0.0.1:8081/metrics?model=x",
    "http://user:password@127.0.0.1:8081/metrics", "https://127.0.0.1:8081/metrics",
    "http://127.0.0.1:65536/metrics", "http://127.0.0.1:0/metrics", "http://127.0.0.1:8081/metrics#x",
  ])("rejects unsupported source %s before network access", async url => {
    const fetcher = vi.fn();
    await expect(observeBackendActivity([{ ...target, url }], { fetch: fetcher })).rejects.toThrow("invalid backend targets");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts IPv6 literal loopback; rejects duplicates and unknown config fields", () => {
    expect(validateBackendTargets([{ id: "ipv6", url: "http://[::1]:8081/metrics" }])).toHaveLength(1);
    for (const bad of [[target, target], [{ ...target, id: "other" }, target], [{ ...target, token: "private" }],
      [{ ...target, id: "bad id" }], Array.from({ length: 17 }, (_, i) => ({ id: `b${i}`, url: `http://127.0.0.1:${1000 + i}/metrics` }))]) {
      expect(() => validateBackendTargets(bad)).toThrow("invalid backend targets");
    }
  });

  it.each([302, 401, 404, 503])("fails closed on HTTP %s without echoing content", async status => {
    const result = await observeBackendActivity([target], { fetch: mockFetch(new Response("PRIVATE", { status })) });
    expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null, reason: "http-error" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("fails closed on missing/malformed metrics and oversized streaming responses", async () => {
    for (const [body, reason] of [["", "missing-metrics"], [metrics.replace(" 2\n", " -1\n"), "invalid-metrics"], ["x".repeat(131073), "body-too-large"]]) {
      const result = await observeBackendActivity([target], { fetch: mockFetch(new Response(body)) });
      expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null, reason });
    }
  });

  it("times out even when transport ignores abort", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const result = await observeBackendActivity([target], { fetch: fetcher, timeoutMs: 10 });
    expect(result.targets[0]).toMatchObject({ state: "unknown", reason: "timeout", active: null, queued: null });
    const signal = (fetcher as any).mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it("bounds body reads as well as response headers", async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(metrics)); } });
    const result = await observeBackendActivity([target], { fetch: mockFetch(new Response(body)), timeoutMs: 10 });
    expect(result.targets[0]).toMatchObject({ state: "unknown", reason: "timeout" });
  });

  it("returns a closed error code without raw transport details", async () => {
    const fetcher = vi.fn(async () => { throw new Error("PRIVATE path"); }) as unknown as typeof fetch;
    const result = await observeBackendActivity([target], { fetch: fetcher });
    expect(result.targets[0]).toMatchObject({ state: "unknown", reason: "request-failed" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
