/**
 * verifyPanelLanded — read-back verification that a pushed panel is actually stored/retrievable.
 * NO real network: globalThis.fetch is stubbed (same pattern as probe-runner.test.ts).
 *
 * Guards the heimdall#102 failure mode: pushPanel returns HTTP 200 (accepted) but the panel is not
 * actually rendered/retrievable. The read-back GETs /api/panels?service=<service> and confirms our
 * panel is present and fresh.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPanelLanded } from "../src/homeserver/heimdall-push.js";

const URL_BASE = "http://heimdall.test:3033/api/panels";
const TOKEN = "test-token";
const OPTS = { url: URL_BASE, token: TOKEN };

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const now = 1_700_000_000_000;
// Pin Heimdall's real read-back contract: the timestamp field is `updated_at` (numeric epoch ms),
// verified live against GET /api/panels?service=m5-inference.
const panels = [
  { panel: "m5-utilization", kind: "timeseries", updated_at: now - 5_000 },
  { panel: "offloadability", kind: "timeseries", updated_at: now - 2 * 24 * 3600 * 1000 }, // 2 days stale
];

describe("verifyPanelLanded", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GETs the ingest path with a ?service= filter and a Bearer token (no token leaked in URL)", async () => {
    const fetchMock = mockFetch(panels);
    await verifyPanelLanded("m5-inference", "m5-utilization", OPTS);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://heimdall.test:3033/api/panels?service=m5-inference");
    expect((init.method ?? "GET")).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(url).not.toContain(TOKEN);
  });

  it("found + ok when the panel is present (no freshness requirement)", async () => {
    mockFetch(panels);
    const r = await verifyPanelLanded("m5-inference", "m5-utilization", OPTS);
    expect(r).toMatchObject({ ok: true, found: true, updatedAt: now - 5_000 });
  });

  it("found:false + ok:false when the panel name is absent (the heimdall#102 case)", async () => {
    mockFetch(panels);
    const r = await verifyPanelLanded("m5-inference", "does-not-exist", OPTS);
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("ok:false when found but staler than maxAgeMs; ok:true when fresh", async () => {
    mockFetch(panels);
    const stale = await verifyPanelLanded("m5-inference", "offloadability", { ...OPTS, maxAgeMs: 3600 * 1000, now });
    expect(stale).toMatchObject({ found: true, fresh: false, ok: false });

    mockFetch(panels);
    const fresh = await verifyPanelLanded("m5-inference", "m5-utilization", { ...OPTS, maxAgeMs: 3600 * 1000, now });
    expect(fresh).toMatchObject({ found: true, fresh: true, ok: true });
  });

  it("tolerates a {panels:[...]} envelope as well as a bare array", async () => {
    mockFetch({ panels });
    const r = await verifyPanelLanded("m5-inference", "m5-utilization", OPTS);
    expect(r.found).toBe(true);
  });

  it("tolerates camelCase/short timestamp aliases (updatedAt / updated)", async () => {
    mockFetch([{ panel: "a", kind: "stat", updatedAt: now - 1_000 }]);
    const camel = await verifyPanelLanded("m5-inference", "a", { ...OPTS, maxAgeMs: 3600 * 1000, now });
    expect(camel).toMatchObject({ found: true, fresh: true, ok: true });

    mockFetch([{ panel: "b", kind: "stat", updated: now - 1_000 }]);
    const short = await verifyPanelLanded("m5-inference", "b", { ...OPTS, maxAgeMs: 3600 * 1000, now });
    expect(short).toMatchObject({ found: true, fresh: true, ok: true });
  });

  it("ok:false with an error class on a non-2xx read-back (never throws)", async () => {
    mockFetch("nope", 503);
    const r = await verifyPanelLanded("m5-inference", "m5-utilization", OPTS);
    expect(r.ok).toBe(false);
    expect(r.found).toBe(false);
    expect(r.status).toBe(503);
    expect(r.error).toContain("503");
  });

  it("config error (no url/token) instead of throwing", async () => {
    const r = await verifyPanelLanded("m5-inference", "m5-utilization", { url: "", token: "" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must both be set/);
  });
});
