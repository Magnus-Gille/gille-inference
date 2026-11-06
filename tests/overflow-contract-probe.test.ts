import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  classifyOverflow,
  fillerUnitsFor,
  parseOverflowTargets,
  runOverflowProbe,
  type OverflowTarget,
} from "../src/homeserver/overflow-contract-probe.js";

const target: OverflowTarget = { model: "fake-model", endpoint: "systemone", effectiveLimitTokens: 1000 };
const KEY = "test-key-not-real";

interface Fake {
  /** Behaviour for the under call (units <= limit) and over call. */
  under: () => Response;
  over: () => Response;
  /** Credits charged by each inference response; undefined = 0. */
  underCharge?: number;
  overCharge?: number;
  balanceBroken?: boolean;
  throwOnOver?: boolean;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const closed400 = () => json(400, { error: { message: "too long", type: "invalid_request_error", code: "context_length_exceeded", param: null } });
const ok200 = () => json(200, { answers: { q: { answer: "yes" } }, usage: { input_tokens: 950, output_tokens: 0 } });
const bad502 = () => json(502, { error: { message: "upstream", type: "api_error", code: "upstream_unavailable", param: null } });

function makeFetch(fake: Fake) {
  let credits = 100;
  const seen: { url: string; auth: string | null; body: string | undefined }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    seen.push({ url, auth: headers?.authorization ?? null, body: init?.body as string | undefined });
    if (url.endsWith("/portal/me")) {
      if (fake.balanceBroken) return json(500, {});
      return json(200, { creditLimit: 0, creditsUsed: credits });
    }
    const units = (JSON.parse(init!.body as string).state as string).split(" ").length;
    const isOver = units > target.effectiveLimitTokens;
    if (isOver && fake.throwOnOver) throw new Error("socket hang up");
    credits += isOver ? fake.overCharge ?? 0 : fake.underCharge ?? 0;
    return isOver ? fake.over() : fake.under();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

async function probe(fake: Fake) {
  const { fetchImpl, seen } = makeFetch(fake);
  const report = await runOverflowProbe([target], { baseUrl: "http://gateway.test", apiKey: KEY, fetchImpl });
  return { report, seen, result: report.results[0]! };
}

describe("overflow contract probe", () => {
  it("fixed_verified: under 200, over closed 400, zero charge", async () => {
    const { report, result, seen } = await probe({ under: ok200, over: closed400, underCharge: 950 });
    expect(result.label).toBe("fixed_verified");
    expect(result.under?.httpStatus).toBe(200);
    expect(result.over).toMatchObject({ httpStatus: 400, errorCode: "context_length_exceeded", chargeDelta: 0 });
    expect(report.allFixedVerified).toBe(true);
    // Exactly two inference calls, bracketing the limit, with the bearer key.
    const posts = seen.filter(s => s.body !== undefined);
    expect(posts).toHaveLength(2);
    expect(posts.every(p => p.auth === `Bearer ${KEY}`)).toBe(true);
    const units = fillerUnitsFor(target);
    expect(units.under).toBeLessThan(target.effectiveLimitTokens);
    expect(units.over).toBeGreaterThan(target.effectiveLimitTokens);
  });

  it("fix_not_effective: pre-INFER-509 behaviour (over -> opaque 502)", async () => {
    const { result, report } = await probe({ under: ok200, over: bad502, underCharge: 950 });
    expect(result.label).toBe("fix_not_effective");
    expect(result.reasons).toContain("over_call_5xx");
    expect(report.allFixedVerified).toBe(false);
  });

  it("fix_not_effective: over 400 with a different, opaque code", async () => {
    const other = () => json(400, { error: { code: "invalid_request_error" } });
    const { result } = await probe({ under: ok200, over: other });
    expect(result.label).toBe("fix_not_effective");
  });

  it("fixed_unbracketed: over closed but under call is not 200", async () => {
    const { result } = await probe({ under: () => json(503, { error: { code: "server_busy" } }), over: closed400 });
    expect(result.label).toBe("fixed_unbracketed");
    expect(result.reasons).toContain("under_call_not_200");
  });

  it("fixed_unbracketed: under call outcome unknown is never verified", () => {
    const over = { httpStatus: 400, errorCode: "context_length_exceeded", fillerUnits: 1050, chargeDelta: 0 };
    expect(classifyOverflow(null, over).label).toBe("fixed_unbracketed");
  });

  it("not fixed_verified when the over call is charged", async () => {
    const { result } = await probe({ under: ok200, over: closed400, overCharge: 7 });
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
    const { result } = await probe({ under: ok200, over: closed400, throwOnOver: true });
    expect(result.label).toBe("inconclusive");
    expect(result.over?.httpStatus).toBeNull();
  });

  it("inconclusive when the over request is accepted", async () => {
    const { result } = await probe({ under: ok200, over: ok200 });
    expect(result.label).toBe("inconclusive");
    expect(result.reasons).toContain("over_call_accepted");
  });

  it("inconclusive (not blamed on the fix) when 5xx but the under call was unhealthy", async () => {
    const { result } = await probe({ under: bad502, over: bad502 });
    expect(result.label).toBe("inconclusive");
  });

  it("report is content-free: no filler, prompts or response text", async () => {
    const { report, seen } = await probe({ under: ok200, over: closed400 });
    const text = JSON.stringify(report);
    expect(seen.some(s => s.body?.includes("alpha bravo"))).toBe(true); // filler was sent...
    expect(text).not.toMatch(/alpha|bravo|too long|answers|Bearer|test-key/); // ...but never reported
  });

  it("chat endpoint builds an OpenAI-shaped request", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      if (String(input).endsWith("/portal/me")) return json(200, { creditsUsed: 0 });
      seen.push(String(input));
      const body = JSON.parse(init!.body as string);
      expect(body.messages[0].role).toBe("user");
      return body.messages[0].content.split(" ").length > 1000 ? closed400() : ok200();
    }) as unknown as typeof fetch;
    const report = await runOverflowProbe([{ ...target, endpoint: "chat" }], { baseUrl: "http://gateway.test", apiKey: KEY, fetchImpl });
    expect(seen).toEqual(["http://gateway.test/v1/chat/completions", "http://gateway.test/v1/chat/completions"]);
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
