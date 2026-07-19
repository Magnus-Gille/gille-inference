import { describe, it, expect } from "vitest";
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
});
