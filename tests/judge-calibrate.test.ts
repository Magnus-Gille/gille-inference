import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadControl } from "../scripts/judge-calibrate.js";

const FIXTURE = resolve("./tests/fixtures/judge-control.jsonl");

describe("loadControl — committed control-set integrity", () => {
  it("parses the real fixture with valid rows", () => {
    const rows = loadControl(FIXTURE);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(["pass", "partial", "fail"]).toContain(r.gold);
      expect(r.prompt.length).toBeGreaterThan(0);
      expect(r.answer.length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const rows = loadControl(FIXTURE);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers both fail and pass golds (a calibration set with only one is useless)", () => {
    const golds = new Set(loadControl(FIXTURE).map((r) => r.gold));
    expect(golds.has("fail")).toBe(true);
    expect(golds.has("pass")).toBe(true);
  });

  it("matches the documented counts (locks docs/harvest-judge-calibration against drift)", () => {
    const rows = loadControl(FIXTURE);
    expect(rows.length).toBe(22);
    const dist = { pass: 0, partial: 0, fail: 0 };
    for (const r of rows) dist[r.gold]++;
    expect(dist).toEqual({ pass: 10, fail: 10, partial: 2 });
    expect(new Set(rows.map((r) => r.taskType)).size).toBe(10);
  });
});

describe("loadControl — validation", () => {
  it("throws on a malformed JSON line", () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-"));
    try {
      const p = join(dir, "bad.jsonl");
      writeFileSync(p, '{"id":"a","taskType":"sql","prompt":"p","answer":"a","gold":"pass"}\n{not json}\n');
      expect(() => loadControl(p)).toThrow(/line 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on an invalid gold value", () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-"));
    try {
      const p = join(dir, "bad.jsonl");
      writeFileSync(p, '{"id":"a","taskType":"sql","prompt":"p","answer":"a","gold":"maybe"}\n');
      expect(() => loadControl(p)).toThrow(/invalid required field/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-"));
    try {
      const p = join(dir, "ok.jsonl");
      writeFileSync(p, '\n{"id":"a","taskType":"sql","prompt":"p","answer":"a","gold":"pass"}\n\n');
      expect(loadControl(p).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
