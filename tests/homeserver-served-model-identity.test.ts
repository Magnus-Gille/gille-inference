import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
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
    const r = reconcileCompletionIdentity('{"model":"a-alt","x":1}', "roster-a", aliases);
    expect(r.kind).toBe("rewritten");
    expect(r.kind === "rewritten" && JSON.parse(r.text)).toEqual({ model: "roster-a", x: 1 });
    expect(reconcileCompletionIdentity("not json", "roster-a", aliases).kind).toBe("unchanged");
    expect(reconcileCompletionIdentity('{"model":"nope"}', "roster-a", aliases).kind).toBe("mismatch");
    expect(reconcileCompletionIdentity('{"model":"nope"}', null, aliases).kind).toBe("unchanged");
  });
});

async function run(input: string[], requested = "roster-a"): Promise<string> {
  const guard = new ServedIdentityGuard(requested, aliases);
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
    const guard = new ServedIdentityGuard("roster-a", aliases);
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
    const guard = new ServedIdentityGuard("roster-a", aliases);
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
