import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  classifyOverflow,
  fillerUnitsFor,
  parseBaseUrl,
  parseOverflowTargets,
  runOverflowProbe,
  type CallObservation,
  type OverflowTarget,
} from "../src/homeserver/overflow-contract-probe.js";

const target: OverflowTarget = { model: "fake-model", endpoint: "systemone", effectiveLimitTokens: 1000 };
const KEY = "test-key-not-real";

interface Fake {
  under: () => Response;
  over: () => Response;
  /** Credits charged by each inference response; default 0. */
  underCharge?: number;
  overCharge?: number;
  /** Meter that never moves (unmetered / stale /portal/me). */
  staticMeter?: boolean;
  balanceBroken?: boolean;
  throwOnOver?: boolean;
  /** Charge becomes visible only after this many /portal/me reads following the call. */
  lagReads?: number;
  /** Add `delta` to the balance when the n-th (1-based) /portal/me read is served. */
  driftAtRead?: { read: number; delta: number };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const closed400 = () => json(400, { error: { message: "too long", type: "invalid_request_error", code: "context_length_exceeded", param: null } });
const ok200 = () => json(200, { answers: { q: { answer: "yes" } }, usage: { input_tokens: 950, output_tokens: 0 } });
const bad502 = () => json(502, { error: { message: "upstream", type: "api_error", code: "upstream_unavailable", param: null } });
const withCode = (status: number, code?: string) => () => json(status, code ? { error: { code } } : {});

function makeFetch(fake: Fake) {
  let actual = 100;
  let visible = 100;
  let pending = 0;
  let lag = 0;
  let reads = 0;
  const seen: { url: string; auth: string | null; body: string | undefined; redirect: string | undefined }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    seen.push({ url, auth: headers?.authorization ?? null, body: init?.body as string | undefined, redirect: init?.redirect });
    if (url.endsWith("/portal/me")) {
      if (fake.balanceBroken) return json(500, {});
      reads++;
      if (fake.driftAtRead?.read === reads) { actual += fake.driftAtRead.delta; visible += fake.driftAtRead.delta; }
      if (pending !== 0) {
        if (lag > 0) lag--;
        else { visible += pending; pending = 0; }
      }
      return json(200, { creditLimit: 0, creditsUsed: visible });
    }
    const units = (JSON.parse(init!.body as string).state as string).split(" ").length;
    const isOver = units > target.effectiveLimitTokens;
    if (isOver && fake.throwOnOver) throw new Error("socket hang up");
    const charge = fake.staticMeter ? 0 : (isOver ? fake.overCharge : fake.underCharge) ?? 0;
    actual += charge;
    if (fake.lagReads) { pending += charge; lag = fake.lagReads; } else visible += charge;
    return isOver ? fake.over() : fake.under();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const fast = { sleep: async () => {}, settleMs: 0 };

async function probe(fake: Fake) {
  const { fetchImpl, seen } = makeFetch(fake);
  const report = await runOverflowProbe([target], { baseUrl: "https://gateway.test", apiKey: KEY, fetchImpl, ...fast });
  return { report, seen, result: report.results[0]! };
}

const obs = (over: Partial<CallObservation>): CallObservation => ({
  httpStatus: 200, errorCode: null, fillerUnits: 1, beforeBalance: 0, afterBalance: 0, chargeDelta: 0, ...over,
});

describe("overflow contract probe", () => {
  it("fixed_verified: under 200 (charged), over closed 400, zero charge", async () => {
    const { report, result, seen } = await probe({ under: ok200, over: closed400, underCharge: 950 });
    expect(result.label).toBe("fixed_verified");
    expect(result.under).toMatchObject({ httpStatus: 200, chargeDelta: 950 });
    expect(result.over).toMatchObject({ httpStatus: 400, errorCode: "context_length_exceeded", chargeDelta: 0 });
    expect(report.allFixedVerified).toBe(true);
    const posts = seen.filter(s => s.body !== undefined);
    expect(posts).toHaveLength(2);
    expect(posts.every(p => p.auth === `Bearer ${KEY}`)).toBe(true);
    const units = fillerUnitsFor(target);
    expect(units.under).toBeLessThan(target.effectiveLimitTokens);
    expect(units.over).toBeGreaterThan(target.effectiveLimitTokens);
  });

  it("every request, including balance reads, uses redirect: error", async () => {
    const { seen } = await probe({ under: ok200, over: closed400, underCharge: 950 });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every(s => s.redirect === "error")).toBe(true);
  });

  it("B1: a static meter never yields fixed_verified", async () => {
    const { result } = await probe({ under: ok200, over: closed400, staticMeter: true });
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("charge_meter_not_live");
  });

  it("B1: under 200 with unreadable balance is not verified", () => {
    const under = obs({ chargeDelta: null, beforeBalance: null });
    const over = obs({ httpStatus: 400, errorCode: "context_length_exceeded" });
    expect(classifyOverflow(under, over)).toMatchObject({ label: "inconclusive", reasons: ["charge_meter_not_live"] });
  });

  it("B2: a delayed charge is settled before the delta is read", async () => {
    const { result } = await probe({ under: ok200, over: closed400, underCharge: 950, lagReads: 1 });
    expect(result.under?.chargeDelta).toBe(950);
    expect(result.label).toBe("fixed_verified");
  });

  it("B2: a delayed charge on the over call is caught, not missed", async () => {
    const { result } = await probe({ under: ok200, over: closed400, underCharge: 950, overCharge: 7, lagReads: 1 });
    expect(result.over?.chargeDelta).toBe(7);
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("over_call_charged");
  });

  it("B2: a falling balance is balance_decreased, not a charge", async () => {
    // Reads: 1 under-before, 2-3 under-after, 4 over-before, 5-6 over-after.
    const { result } = await probe({ under: ok200, over: closed400, underCharge: 950, driftAtRead: { read: 5, delta: -9 } });
    expect(result.over?.chargeDelta).toBe(-9);
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("balance_decreased");
  });

  it("B2: balance moving between the calls is inconclusive (a release that would net out a charge)", async () => {
    const { result } = await probe({ under: ok200, over: closed400, underCharge: 950, driftAtRead: { read: 4, delta: -7 } });
    expect(result.under?.afterBalance).not.toBe(result.over?.beforeBalance);
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("balance_moved_between_calls");
  });

  it("B2: an unstable balance that never settles is missing evidence", async () => {
    let n = 0;
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      if (String(input).endsWith("/portal/me")) return json(200, { creditsUsed: n++ });
      const isOver = (JSON.parse(init!.body as string).state as string).split(" ").length > 1000;
      return isOver ? closed400() : ok200();
    }) as unknown as typeof fetch;
    const report = await runOverflowProbe([target], { baseUrl: "https://gateway.test", apiKey: KEY, fetchImpl, ...fast, maxSettleReads: 3 });
    expect(report.results[0]!.under?.afterBalance).toBeNull();
    expect(report.results[0]!.label).toBe("inconclusive");
  });

  it("fix_not_effective: pre-INFER-509 behaviour (over -> opaque 502)", async () => {
    const { result, report } = await probe({ under: ok200, over: bad502, underCharge: 950 });
    expect(result.label).toBe("fix_not_effective");
    expect(result.reasons).toContain("over_call_5xx");
    expect(report.allFixedVerified).toBe(false);
  });

  it.each([[400, undefined], [400, "invalid_request_error"], [422, "unprocessable"]])(
    "fix_not_effective: over %s with missing/unexpected code %s", async (status, code) => {
      const { result } = await probe({ under: ok200, over: withCode(status, code), underCharge: 950 });
      expect(result.label).toBe("fix_not_effective");
    });

  it.each([
    [401, undefined], [402, "credits_exhausted"], [403, undefined], [408, undefined], [413, "payload_too_large"],
    [429, "rate_limit_exceeded"], [503, "server_busy"], [400, "request_exceeds_quota"],
  ])("N1: over %s %s is an admission rejection, not the fix's fault", async (status, code) => {
    const { result } = await probe({ under: ok200, over: withCode(status, code), underCharge: 950 });
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("over_call_admission_rejected");
  });

  it("fixed_unbracketed: over closed but under call is not 200", async () => {
    const { result } = await probe({ under: () => json(503, { error: { code: "server_busy" } }), over: closed400 });
    expect(result.label).toBe("fixed_unbracketed");
    expect(result.reasons).toContain("under_call_not_200");
  });

  it("fixed_unbracketed: a missing under call is never verified", () => {
    const over = obs({ httpStatus: 400, errorCode: "context_length_exceeded", fillerUnits: 1050 });
    expect(classifyOverflow(null, over).label).toBe("fixed_unbracketed");
  });

  it("not fixed_verified when the over call is charged", async () => {
    const { result } = await probe({ under: ok200, over: closed400, underCharge: 950, overCharge: 7 });
    expect(result.label).toBe("inconclusive");
    expect(result.over?.chargeDelta).toBe(7);
    expect(result.reasons).toContain("over_call_charged");
  });

  it("inconclusive when charge evidence is missing", async () => {
    const { result } = await probe({ under: ok200, over: closed400, balanceBroken: true });
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("charge_evidence_missing");
  });

  it("inconclusive when the over call outcome is unknown", async () => {
    const { result } = await probe({ under: ok200, over: closed400, underCharge: 950, throwOnOver: true });
    expect(result.label).toBe("inconclusive");
    expect(result.over?.httpStatus).toBeNull();
  });

  it("inconclusive when the over request is accepted", async () => {
    const { result } = await probe({ under: ok200, over: ok200, underCharge: 950 });
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("over_call_accepted");
  });

  it("inconclusive (not blamed on the fix) when 5xx but the under call was unhealthy", async () => {
    const { result } = await probe({ under: bad502, over: bad502 });
    expect(result.label).toBe("inconclusive");
  });

  it("report is content-free: no filler, prompts or response text", async () => {
    const { report, seen } = await probe({ under: ok200, over: closed400, underCharge: 950 });
    const text = JSON.stringify(report);
    expect(seen.some(s => s.body?.includes("alpha bravo"))).toBe(true);
    expect(text).not.toMatch(/alpha|bravo|too long|answers|Bearer|test-key/);
  });

  it("chat endpoint builds an OpenAI-shaped request and needs a live meter", async () => {
    const seen: string[] = [];
    let credits = 0;
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      if (String(input).endsWith("/portal/me")) return json(200, { creditsUsed: credits });
      seen.push(String(input));
      const body = JSON.parse(init!.body as string);
      expect(body.messages[0].role).toBe("user");
      if (body.messages[0].content.split(" ").length > 1000) return closed400();
      credits += 50;
      return ok200();
    }) as unknown as typeof fetch;
    const report = await runOverflowProbe([{ ...target, endpoint: "chat" }], { baseUrl: "https://gateway.test", apiKey: KEY, fetchImpl, ...fast });
    expect(seen).toEqual(["https://gateway.test/v1/chat/completions", "https://gateway.test/v1/chat/completions"]);
    expect(report.results[0]!.label).toBe("fixed_verified");
  });

  it("rejects malformed targets", () => {
    expect(() => parseOverflowTargets([])).toThrow();
    expect(() => parseOverflowTargets([{ model: "m", endpoint: "x", effectiveLimitTokens: 100 }])).toThrow();
    expect(() => parseOverflowTargets([{ model: "m", endpoint: "chat", effectiveLimitTokens: 4 }])).toThrow();
    expect(() => parseOverflowTargets([{ model: "m", endpoint: "chat", effectiveLimitTokens: 100, extra: 1 }])).toThrow();
    expect(() => parseOverflowTargets([{ model: "m", endpoint: "chat", effectiveLimitTokens: 100_000 }])).toThrow();
    expect(parseOverflowTargets([{ model: "m", endpoint: "chat", effectiveLimitTokens: 100 }])).toHaveLength(1);
  });

  it("N2: base URL validation", () => {
    expect(parseBaseUrl("https://gateway.example")).toBe("https://gateway.example");
    expect(parseBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parseBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(parseBaseUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
    for (const bad of [
      "http://gateway.example", "ftp://x", "not a url", "https://user:pw@gateway.example", "https://gateway.example?x=1",
      "https://gateway.example/#f", "https://gateway.example/prefix",
    ]) expect(() => parseBaseUrl(bad), bad).toThrow();
  });
});

describe("deploy scripts never run the probe", () => {
  it("no other script references check-overflow-contract", async () => {
    const dir = resolve("scripts");
    const offenders: string[] = [];
    for (const name of await readdir(dir)) {
      if (name === "check-overflow-contract.ts") continue;
      const text = await readFile(join(dir, name), "utf8").catch(() => "");
      if (text.includes("check-overflow-contract")) offenders.push(name);
    }
    expect(offenders).toEqual([]);
    expect(await readFile(join(dir, "deploy-gateway.sh"), "utf8")).not.toMatch(/overflow/i);
  });
});

describe("check-overflow-contract CLI", () => {
  const exec = promisify(execFile);
  const script = resolve("scripts/check-overflow-contract.ts");
  const run = (args: string[], env: Record<string, string> = {}) =>
    exec(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: resolve("."),
      env: { PATH: "/usr/bin:/bin", FORCE_COLOR: "0", NODE_NO_WARNINGS: "1", ...env },
    });

  it("defaults to an offline plan and refuses --live without an envelope reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overflow-probe-"));
    try {
      const file = join(dir, "targets.json");
      await writeFile(file, JSON.stringify([{ model: "m", endpoint: "systemone", effectiveLimitTokens: 1000 }]));
      const plan = JSON.parse((await run(["--targets", file])).stdout);
      expect(plan).toMatchObject({ mode: "plan", network: false });
      expect(plan.plan[0]).toMatchObject({ inferenceCalls: 2, fillerUnits: { under: 950, over: 1050 } });
      await expect(run(["--targets", file, "--live", "--base-url", "http://127.0.0.1:1"])).rejects.toMatchObject({ code: 2 });
      await expect(run(["--targets", file, "--live", "--envelope-ref", "env-1", "--base-url", "http://127.0.0.1:1"])).rejects.toMatchObject({ code: 2 });
      // N4: a flag followed by another flag has no value.
      await expect(run(["--targets", file, "--live", "--envelope-ref", "--base-url", "https://x.example"])).rejects.toMatchObject({ code: 2 });
      await expect(run(["--targets"])).rejects.toMatchObject({ code: 2 });
      // N2: bad base URLs exit 2 before any request (key present, nothing is sent).
      for (const bad of ["http://gateway.example", "https://u:p@gateway.example", "https://gateway.example/prefix"]) {
        await expect(run(["--targets", file, "--live", "--envelope-ref", "env-1", "--base-url", bad], { OVERFLOW_PROBE_API_KEY: "k" }))
          .rejects.toMatchObject({ code: 2 });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
