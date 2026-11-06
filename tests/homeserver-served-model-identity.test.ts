import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";
import { Readable } from "node:stream";
import {
  MAX_PENDING_SSE_EVENT_CHARS,
  rosterIdentityOf,
  unknownAliasRosterIds,
  parseServedModelIdentityMode,
  judgeServedIdentity,
  parseServedModelAliases,
  reconcileCompletionIdentity,
  ServedIdentityGuard,
  ServedIdentityMismatchError,
} from "../src/homeserver/served-model-identity.js";

const aliases = parseServedModelAliases(["roster-a=/srv/a.gguf", "roster-a=a-alt", "roster-b=/srv/b.gguf"]);

describe("parseServedModelAliases", () => {
  it("collects several served identities per roster ID", () => {
    expect([...(aliases.get("roster-a") ?? [])]).toEqual(["/srv/a.gguf", "a-alt"]);
  });
  it("rejects malformed pairs without echoing the value", () => {
    for (const bad of ["nopair", "=x", "x=", "x=x", "a=b\u0000c"]) {
      expect(() => parseServedModelAliases([bad])).toThrow(/entry 1 is not a valid/);
      try { parseServedModelAliases([bad]); } catch (e) { expect(String(e)).not.toContain(bad || "zzz-never"); }
    }
  });
});

describe("judgeServedIdentity", () => {
  it("classifies each case", () => {
    expect(judgeServedIdentity("roster-a", "roster-a", aliases)).toBe("canonical");
    expect(judgeServedIdentity("roster-a", "/srv/a.gguf", aliases)).toBe("aliased");
    expect(judgeServedIdentity("roster-a", "/srv/b.gguf", aliases)).toBe("mismatch");
    expect(judgeServedIdentity("roster-a", "other", aliases)).toBe("mismatch");
    expect(judgeServedIdentity("roster-a", undefined, aliases)).toBe("absent");
    expect(judgeServedIdentity("roster-a", null, aliases)).toBe("absent");
    expect(judgeServedIdentity("roster-a", 7, aliases)).toBe("mismatch");
  });
});

describe("reconcileCompletionIdentity", () => {
  it("rewrites only a declared alias and leaves non-JSON alone", () => {
    const r = reconcileCompletionIdentity('{"model":"a-alt","x":1}', "roster-a", aliases, "enforce");
    expect(r.kind).toBe("rewritten");
    expect(r.kind === "rewritten" && JSON.parse(r.text)).toEqual({ model: "roster-a", x: 1 });
    expect(reconcileCompletionIdentity("not json", "roster-a", aliases, "enforce").kind).toBe("unchanged");
    expect(reconcileCompletionIdentity('{"model":"nope"}', "roster-a", aliases, "enforce").kind).toBe("mismatch");
    expect(reconcileCompletionIdentity('{"model":"nope"}', null, aliases, "enforce").kind).toBe("unchanged");
  });
});

async function run(input: string[], requested = "roster-a"): Promise<string> {
  const guard = new ServedIdentityGuard(requested, aliases, "enforce");
  const out: string[] = [];
  guard.on("data", (c: Buffer) => out.push(c.toString("utf8")));
  await new Promise<void>((resolve, reject) => {
    guard.on("end", resolve);
    guard.on("error", reject);
    Readable.from(input.map((s) => Buffer.from(s))).pipe(guard);
  });
  return out.join("");
}

describe("ServedIdentityGuard", () => {
  it("rewrites aliased frames across arbitrary chunk boundaries and passes everything else through", async () => {
    const frame = 'data: {"model":"/srv/a.gguf","c":"é"}\n\n';
    const bytes = Buffer.from(frame + ": keepalive\n\ndata: [DONE]\n\n");
    // Split inside the multi-byte character too.
    const cut = bytes.indexOf(0xc3) + 1;
    const guard = new ServedIdentityGuard("roster-a", aliases, "enforce");
    const chunks: string[] = [];
    guard.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
    const done = new Promise<void>((r) => guard.on("end", r));
    guard.write(bytes.subarray(0, cut));
    guard.write(bytes.subarray(cut, cut + 7));
    guard.end(bytes.subarray(cut + 7));
    await done;
    expect(chunks.join("")).toBe('data: {"model":"roster-a","c":"é"}\n\n: keepalive\n\ndata: [DONE]\n\n');
  });

  it("errors on a mismatching frame and never forwards it", async () => {
    const guard = new ServedIdentityGuard("roster-a", aliases, "enforce");
    const seen: string[] = [];
    guard.on("data", (c: Buffer) => seen.push(c.toString("utf8")));
    const failed = new Promise<unknown>((r) => guard.on("error", r));
    guard.write('data: {"model":"roster-a","n":1}\n\n');
    guard.write('data: {"model":"/srv/b.gguf","n":2}\n\n');
    expect(await failed).toBeInstanceOf(ServedIdentityMismatchError);
    expect(seen.join("")).toBe('data: {"model":"roster-a","n":1}\n\n');
  });

  it("checks a final unterminated frame", async () => {
    await expect(run(['data: {"model":"zzz"}'])).rejects.toBeInstanceOf(ServedIdentityMismatchError);
  });
});

describe("parseServedModelIdentityMode", () => {
  it("defaults to shadow and accepts the three modes", () => {
    expect(parseServedModelIdentityMode(undefined)).toBe("shadow");
    expect(parseServedModelIdentityMode("")).toBe("shadow");
    for (const m of ["off", "shadow", "enforce"] as const) expect(parseServedModelIdentityMode(m)).toBe(m);
  });
  it("aborts on an invalid value without echoing it", () => {
    expect(() => parseServedModelIdentityMode("Enforce-secret-x")).toThrow(/must be one of/);
    try { parseServedModelIdentityMode("Enforce-secret-x"); } catch (e) { expect(String(e)).not.toContain("secret-x"); }
  });
});

describe("mode-aware helpers", () => {
  it("reconcile: shadow passes a mismatch through, off ignores everything, aliases still rewrite in shadow", () => {
    const body = '{"model":"nope"}';
    expect(reconcileCompletionIdentity(body, "roster-a", aliases, "shadow")).toEqual({ kind: "mismatch_shadow", text: body });
    expect(reconcileCompletionIdentity(body, "roster-a", aliases, "off")).toEqual({ kind: "unchanged", text: body });
    expect(reconcileCompletionIdentity('{"model":"a-alt"}', "roster-a", aliases, "shadow").kind).toBe("rewritten");
  });
  it("guard in shadow forwards a mismatching frame and reports it once", async () => {
    let n = 0;
    const guard = new ServedIdentityGuard("roster-a", aliases, "shadow", () => { n++; });
    const out: string[] = [];
    guard.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const done = new Promise<void>((r) => guard.on("end", r));
    guard.write('data: {"model":"x1"}\n\n');
    guard.write('data: {"model":"x2"}\n\n');
    guard.end('data: {"model":"/srv/a.gguf"}\n\n');
    await done;
    expect(out.join("")).toBe('data: {"model":"x1"}\n\ndata: {"model":"x2"}\n\ndata: {"model":"roster-a"}\n\n');
    expect(n).toBe(1);
  });
});

describe("loadConfig served-model identity", () => {
  const KEYS = ["HOMESERVER_SERVED_MODEL_IDENTITY", "HOMESERVER_SERVED_MODEL_ALIASES"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    resetConfig();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    resetConfig();
  });

  it("defaults to shadow with no aliases", () => {
    const cfg = loadConfig();
    expect(cfg.servedModelIdentity).toBe("shadow");
    expect(cfg.servedModelAliases.size).toBe(0);
  });
  it("reads mode and aliases from the environment", () => {
    process.env["HOMESERVER_SERVED_MODEL_IDENTITY"] = "enforce";
    process.env["HOMESERVER_SERVED_MODEL_ALIASES"] = "qwen3-30b-instruct=/m/q.gguf";
    const cfg = loadConfig();
    expect(cfg.servedModelIdentity).toBe("enforce");
    expect(cfg.servedModelAliases.get("qwen3-30b-instruct")?.has("/m/q.gguf")).toBe(true);
  });
  it("aborts startup on an invalid mode or alias without echoing the value", () => {
    process.env["HOMESERVER_SERVED_MODEL_IDENTITY"] = "bogus-value-1";
    expect(() => loadConfig()).toThrow(/must be one of/);
    delete process.env["HOMESERVER_SERVED_MODEL_IDENTITY"];
    resetConfig();
    process.env["HOMESERVER_SERVED_MODEL_ALIASES"] = "bogus-value-2";
    expect(() => loadConfig()).toThrow(/not a valid/);
    try { loadConfig(); } catch (e) { expect(String(e)).not.toContain("bogus-value-2"); }
  });
});

async function pipeThrough(chunks: string[], mode: "shadow" | "enforce", count?: () => void): Promise<string> {
  const guard = new ServedIdentityGuard("roster-a", aliases, mode, count);
  const out: string[] = [];
  guard.on("data", (c: Buffer) => out.push(c.toString("utf8")));
  await new Promise<void>((resolve, reject) => {
    guard.on("end", resolve);
    guard.on("error", reject);
    Readable.from(chunks.map((c) => Buffer.from(c))).pipe(guard);
  });
  return out.join("");
}

describe("ServedIdentityGuard SSE framing (N1)", () => {
  const rewritten = (eol: string, space = " ") => `data:${space}{"model":"roster-a","n":1}${eol}${eol}`;
  const framings: Array<[string, string, string]> = [
    ["no space after data:", 'data:{"model":"/srv/a.gguf","n":1}\n\n', rewritten("\n")],
    ["extra spaces after data:", 'data:    {"model":"/srv/a.gguf","n":1}\n\n', rewritten("\n")],
    ["tab after data:", 'data:\t{"model":"/srv/a.gguf","n":1}\n\n', rewritten("\n")],
    ["trailing whitespace after the JSON", 'data: {"model":"/srv/a.gguf","n":1}   \n\n', rewritten("\n")],
    ["CRLF line endings", 'data: {"model":"/srv/a.gguf","n":1}\r\n\r\n', rewritten("\r\n")],
    ["multi-line data joined per spec", 'data: {"model":"/srv/a.gguf",\ndata: "n":1}\n\n', rewritten("\n")],
    ["event/id lines kept", 'event: message\nid: 7\ndata: {"model":"/srv/a.gguf","n":1}\n\n', 'event: message\nid: 7\ndata: {"model":"roster-a","n":1}\n\n'],
    ["unterminated final event", 'data: {"model":"/srv/a.gguf","n":1}', 'data: {"model":"roster-a","n":1}\n\n'],
  ];
  for (const [name, input, expected] of framings) {
    it(`rewrites an alias: ${name}`, async () => {
      expect(await pipeThrough([input], "enforce")).toBe(expected);
      // and split into 3-char chunks
      expect(await pipeThrough(input.match(/[\s\S]{1,3}/g)!, "enforce")).toBe(expected);
    });
    it(`rejects a mismatch in enforce: ${name}`, async () => {
      const bad = input.replace("/srv/a.gguf", "/srv/zzz.gguf");
      await expect(pipeThrough([bad], "enforce")).rejects.toBeInstanceOf(ServedIdentityMismatchError);
    });
  }

  it("passes comments, [DONE], model-free and non-JSON events through byte-for-byte", async () => {
    const raw = ': keepalive\n\ndata: [DONE]\n\ndata: {"choices":[]}\n\ndata: plain text\n\nevent: ping\n\n';
    expect(await pipeThrough([raw], "enforce")).toBe(raw);
  });

  it("does not misread a model-looking string inside content", async () => {
    const raw = 'data: {"choices":[{"delta":{"content":"say \\"model\\": x"}}]}\n\n';
    expect(await pipeThrough([raw], "enforce")).toBe(raw);
  });

  it("enforce: an unparsable JSON-looking event that mentions model is unverifiable", async () => {
    await expect(pipeThrough(['data: {"model": broken\n\n'], "enforce")).rejects.toMatchObject({ reason: "unverifiable" });
  });

  it("enforce: a unicode-escaped key is not allowed to bypass the fast path", async () => {
    await expect(pipeThrough(['data: {"mod\\u0065l":"nope"}\n\n'], "enforce")).rejects.toBeInstanceOf(ServedIdentityMismatchError);
  });

  it("shadow: unverifiable and mismatching events pass through unchanged and are counted once", async () => {
    let n = 0;
    const raw = 'data: {"model": broken\n\ndata: {"model":"zzz"}\n\n';
    expect(await pipeThrough([raw], "shadow", () => { n++; })).toBe(raw);
    expect(n).toBe(1);
  });

  it("bounds a pending event: enforce fails closed, shadow passes through and counts", async () => {
    const huge = `data: {"model":"roster-a","pad":"${"x".repeat(MAX_PENDING_SSE_EVENT_CHARS)}"}`;
    await expect(pipeThrough([huge.slice(0, 5000), huge.slice(5000)], "enforce")).rejects.toMatchObject({ reason: "overflow" });
    let n = 0;
    const out = await pipeThrough([huge.slice(0, 5000), huge.slice(5000), "\n\n", 'data: {"model":"/srv/a.gguf"}\n\n'], "shadow", () => { n++; });
    expect(out.startsWith(huge)).toBe(true);
    expect(out.endsWith('data: {"model":"roster-a"}\n\n')).toBe(true);
    expect(n).toBe(1);
  });
});

describe("rosterIdentityOf / unknownAliasRosterIds", () => {
  it("maps sentinels to null and keeps roster IDs", () => {
    expect(rosterIdentityOf("roster-a")).toBe("roster-a");
    for (const v of [null, undefined, "", "unknown", "none"]) expect(rosterIdentityOf(v)).toBeNull();
  });
  it("lists alias keys missing from the roster (IDs only)", () => {
    expect(unknownAliasRosterIds(aliases, new Set(["roster-a"]))).toEqual(["roster-b"]);
  });
});
