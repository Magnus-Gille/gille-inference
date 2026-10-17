import { describe, it, expect } from "vitest";
import { delimiter, dirname } from "node:path";
import {
  exact,
  answerIs,
  numeric,
  maxLength,
  containsAll,
  containsNone,
  jsonValid,
  matches,
  predicate,
  all,
  nonEmpty,
  stripThink,
  extractCodeBlock,
  tsGate,
  verifierChildEnvironment,
} from "../src/homeserver/verifier.js";

describe("verifier factories", () => {
  it("exact normalizes whitespace", async () => {
    expect((await exact("hello world")("  hello   world ")).outcome).toBe("pass");
    expect((await exact("hello")("bye")).outcome).toBe("fail");
  });

  it("answerIs matches a substring, case-insensitively", async () => {
    expect((await answerIs("192.168.4.27")("The IP is 192.168.4.27.")).outcome).toBe("pass");
    expect((await answerIs("negative", { ci: true })("NEGATIVE")).outcome).toBe("pass");
    expect((await answerIs("x")("y")).outcome).toBe("fail");
  });

  it("numeric extracts the last number", async () => {
    expect((await numeric(36)("15% of 240 is 36")).outcome).toBe("pass");
    expect((await numeric(36)("the answer is 35")).outcome).toBe("fail");
    expect((await numeric(0)("no digits here")).outcome).toBe("fail");
  });

  it("maxLength enforces upper and lower bounds", async () => {
    expect((await maxLength(10)("short")).outcome).toBe("pass");
    expect((await maxLength(3)("toolong")).outcome).toBe("fail");
    expect((await maxLength(100, { min: 5 })("hi")).outcome).toBe("fail");
  });

  it("containsAll reports partials", async () => {
    expect((await containsAll(["a", "b"])("a and b")).outcome).toBe("pass");
    expect((await containsAll(["a", "b", "c"])("only a")).outcome).toBe("partial");
    expect((await containsAll(["x"])("none")).outcome).toBe("fail");
  });

  it("containsNone passes when none match, fails when any match", async () => {
    expect((await containsNone(["getUser", "oldName"])("function fetchUser() {}")).outcome).toBe("pass");
    expect((await containsNone(["getUser"])("function getUser() {}")).outcome).toBe("fail");
    // ci: true (default) — case-insensitive
    expect((await containsNone(["getuser"], { ci: true })("function GETUSER() {}")).outcome).toBe("fail");
    // ci: false — case-sensitive; different case should pass
    expect((await containsNone(["getUser"], { ci: false })("function GETUSER() {}")).outcome).toBe("pass");
  });

  it("jsonValid parses output and runs a predicate", async () => {
    expect((await jsonValid()('{"a":1}')).outcome).toBe("pass");
    expect((await jsonValid()("not json")).outcome).toBe("error");
    expect((await jsonValid((v) => Array.isArray(v))("[1,2]")).outcome).toBe("pass");
    expect((await jsonValid((v) => Array.isArray(v))('{"a":1}')).outcome).toBe("fail");
  });

  it("matches and predicate", async () => {
    expect((await matches(/not found/i)("404 Not Found")).outcome).toBe("pass");
    expect((await predicate((o) => o.includes("ok"))("ok")).outcome).toBe("pass");
  });

  it("all() returns the worst outcome; empty is unverified", async () => {
    expect((await all([nonEmpty(), matches(/x/)])("has x")).outcome).toBe("pass");
    expect((await all([nonEmpty(), matches(/zzz/)])("no match")).outcome).toBe("fail");
    expect((await all([])("anything")).outcome).toBe("unverified");
  });

  it("stripThink removes reasoning; extractCodeBlock prefers the ts block", () => {
    expect(stripThink("<think>reasoning here</think>answer")).toBe("answer");
    expect(extractCodeBlock("prose\n```ts\nconst x = 1;\n```\nmore")).toBe("const x = 1;");
  });
});

describe("tsGate compile + run gate", () => {
  it("passes correct code and fails wrong code", async () => {
    const v = tsGate({ harness: "if (add(2, 3) !== 5) throw new Error('bad');" });
    const good = "```ts\nexport function add(a: number, b: number): number { return a + b; }\n```";
    const bad = "```ts\nexport function add(a: number, b: number): number { return a - b; }\n```";
    expect((await v(good)).outcome).toBe("pass");
    expect((await v(bad)).outcome).toBe("fail");
  }, 60_000);

  it("runs model code without gateway env, outside the repo, and with a scratch HOME", async () => {
    const repoRoot = process.cwd();
    const realHome = process.env["HOME"] ?? "";
    const canaries: Record<string, string | undefined> = {
      HOMESERVER_TEST_CANARY: process.env["HOMESERVER_TEST_CANARY"],
      M5_MAINTENANCE_KEY: process.env["M5_MAINTENANCE_KEY"],
      NODE_OPTIONS: process.env["NODE_OPTIONS"],
    };
    process.env["HOMESERVER_TEST_CANARY"] = "leak";
    process.env["M5_MAINTENANCE_KEY"] = "leak";
    process.env["NODE_OPTIONS"] = "--max-old-space-size=128";
    try {
      const harness = [
        "const leaks: string[] = [];",
        'if (process.env["HOMESERVER_TEST_CANARY"] !== undefined) leaks.push("HOMESERVER_TEST_CANARY");',
        'if (process.env["M5_MAINTENANCE_KEY"] !== undefined) leaks.push("M5_MAINTENANCE_KEY");',
        'if (process.env["NODE_OPTIONS"] !== undefined) leaks.push("NODE_OPTIONS");',
        `if (process.cwd() === ${JSON.stringify(repoRoot)}) leaks.push("repo cwd");`,
        `if (process.env["HOME"] === ${JSON.stringify(realHome)}) leaks.push("real HOME");`,
        'if (leaks.length > 0) throw new Error("verifier child leaked: " + leaks.join(", "));',
      ].join("\n");
      const r = await tsGate({ harness })("```ts\nconst answer: number = 6 * 7;\n```");
      expect(r.notes).not.toContain("leaked");
      expect(r.outcome).toBe("pass");
    } finally {
      for (const [k, v] of Object.entries(canaries)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 60_000);

  it("refuses to run at all when the process is root", async () => {
    const original = process.getuid;
    process.getuid = () => 0;
    try {
      const r = await tsGate({ harness: "" })("```ts\nconst x: number = 1;\n```");
      expect(r.outcome).toBe("error");
      expect(r.errorClass).toBe("infra");
      expect(r.notes).toContain("root");
    } finally {
      process.getuid = original;
    }
  });
});

describe("verifierChildEnvironment", () => {
  it("keeps only the allowlist and drops secrets and tool-injection variables", () => {
    const canaries: Record<string, string | undefined> = {
      HOMESERVER_TEST_CANARY: process.env["HOMESERVER_TEST_CANARY"],
      M5_MAINTENANCE_KEY: process.env["M5_MAINTENANCE_KEY"],
      NODE_OPTIONS: process.env["NODE_OPTIONS"],
      NODE_PATH: process.env["NODE_PATH"],
    };
    process.env["HOMESERVER_TEST_CANARY"] = "x";
    process.env["M5_MAINTENANCE_KEY"] = "x";
    process.env["NODE_OPTIONS"] = "--max-old-space-size=128";
    process.env["NODE_PATH"] = "/tmp/inject";
    try {
      const env = verifierChildEnvironment("/scratch/home");
      expect(env["HOME"]).toBe("/scratch/home");
      expect(env["TMPDIR"]).toBe("/scratch/home");
      expect(env["PATH"]?.split(delimiter)[0]).toBe(dirname(process.execPath));
      expect(env["HOMESERVER_TEST_CANARY"]).toBeUndefined();
      expect(env["M5_MAINTENANCE_KEY"]).toBeUndefined();
      expect(env["NODE_OPTIONS"]).toBeUndefined();
      expect(env["NODE_PATH"]).toBeUndefined();
      const allowlist = ["HOME", "TMPDIR", "PATH", "LANG"];
      expect(Object.keys(env).every((k) => allowlist.includes(k))).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(canaries)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
