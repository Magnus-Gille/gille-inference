import { describe, it, expect } from "vitest";
import { percentile } from "../src/analysis/stats.js";

describe("percentile", () => {
  it("returns the median for p=50 on odd-length array", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("returns the min for p=0", () => {
    expect(percentile([5, 1, 4, 2, 3], 0)).toBe(1);
  });

  it("returns the max for p=100", () => {
    expect(percentile([5, 1, 4, 2, 3], 100)).toBe(5);
  });

  it("interpolates linearly between ranks", () => {
    // [1,2,3,4] at p=50: between 2 and 3, equal weight → 2.5
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 5);
  });

  it("handles single-element arrays", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it("throws on empty array", () => {
    expect(() => percentile([], 50)).toThrow();
  });

  it("throws when p < 0", () => {
    expect(() => percentile([1, 2, 3], -1)).toThrow();
  });

  it("throws when p > 100", () => {
    expect(() => percentile([1, 2, 3], 101)).toThrow();
  });

  it("throws when p is NaN", () => {
    expect(() => percentile([1, 2, 3], NaN)).toThrow();
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });
});
