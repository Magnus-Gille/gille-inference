import { describe, it, expect } from "vitest";
import { DegeneracyWatchdog } from "../src/homeserver/degeneracy-watchdog.js";

describe("DegeneracyWatchdog", () => {
  it("does not trip on normal varied prose", () => {
    const w = new DegeneracyWatchdog(50);
    expect(w.feed("The quick brown fox jumps over the lazy dog. ".repeat(20))).toBe(false);
    expect(w.tripped).toBe(false);
  });

  it("trips once a single non-whitespace char repeats >= threshold", () => {
    const w = new DegeneracyWatchdog(50);
    expect(w.feed("ok then ")).toBe(false);
    expect(w.feed("?".repeat(49))).toBe(false); // one short of threshold
    expect(w.feed("?")).toBe(true); // 50th consecutive '?' → trip
    expect(w.tripped).toBe(true);
  });

  it("accumulates a run across multiple feed() chunks (delta boundary is not a run boundary)", () => {
    const w = new DegeneracyWatchdog(10);
    expect(w.feed("?????")).toBe(false); // 5
    expect(w.feed("?????")).toBe(true); // 10th '?' crosses threshold within this feed
    expect(w.tripped).toBe(true);
  });

  it("latches: stays tripped on subsequent feeds even after the run ends", () => {
    const w = new DegeneracyWatchdog(5);
    expect(w.feed("xxxxx")).toBe(true);
    expect(w.feed("normal text resumes")).toBe(true);
    expect(w.tripped).toBe(true);
  });

  it("resets the run when a different character appears", () => {
    const w = new DegeneracyWatchdog(5);
    expect(w.feed("aaaa")).toBe(false); // 4 a's
    expect(w.feed("bbbb")).toBe(false); // different char → run resets to b's (4)
    expect(w.tripped).toBe(false);
  });

  it("treats whitespace as a run breaker (whitespace-separated repeats never trip)", () => {
    const w = new DegeneracyWatchdog(5);
    // single '?' tokens separated by spaces → each run is length 1
    expect(w.feed("? ? ? ? ? ? ? ? ? ? ? ?")).toBe(false);
    expect(w.tripped).toBe(false);
  });

  it("does not trip on long legitimate whitespace runs (deep indentation / blank lines)", () => {
    const w = new DegeneracyWatchdog(20);
    expect(w.feed(" ".repeat(200))).toBe(false);
    expect(w.feed("\n".repeat(200))).toBe(false);
    expect(w.tripped).toBe(false);
  });

  it("does not trip below threshold on a markdown rule / table separator", () => {
    const w = new DegeneracyWatchdog(400);
    expect(w.feed("-".repeat(80))).toBe(false);
    expect(w.feed("=".repeat(80))).toBe(false);
    expect(w.tripped).toBe(false);
  });

  it("ignores empty deltas (role-only frames)", () => {
    const w = new DegeneracyWatchdog(5);
    expect(w.feed("")).toBe(false);
    expect(w.feed("aa")).toBe(false);
    expect(w.feed("")).toBe(false);
    expect(w.feed("aaa")).toBe(true); // run continues across the empty delta
  });

  it("a threshold of 0 disables the watchdog (never trips)", () => {
    const w = new DegeneracyWatchdog(0);
    expect(w.feed("?".repeat(100000))).toBe(false);
    expect(w.tripped).toBe(false);
  });

  it("normalizes a fractional threshold to an integer (does not trip on the first char)", () => {
    // A misconfigured 0.5 would trip at runLen>=0.5 (first char) without flooring → disabled.
    const disabled = new DegeneracyWatchdog(0.5);
    expect(disabled.feed("a")).toBe(false);
    expect(disabled.tripped).toBe(false);
    // 2.9 floors to 2 → trips on the 2nd identical char, not the 3rd.
    const w = new DegeneracyWatchdog(2.9);
    expect(w.feed("x")).toBe(false);
    expect(w.feed("x")).toBe(true);
  });

  it("exposes the current run length for observability", () => {
    const w = new DegeneracyWatchdog(50);
    w.feed("aaa");
    expect(w.runLength).toBe(3);
    w.feed("a");
    expect(w.runLength).toBe(4);
    w.feed("b");
    expect(w.runLength).toBe(1);
  });
});
