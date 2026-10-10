import { describe, expect, it } from "vitest";

import { parseLlamaCppActivityMetrics } from "../src/homeserver/backend-activity-metrics.js";

const FIXTURE = `# HELP llamacpp:requests_processing Number of requests processing
# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 2
# HELP llamacpp:requests_deferred Number of requests deferred
# TYPE llamacpp:requests_deferred gauge
llamacpp:requests_deferred 1.0
# TYPE unrelated_metric gauge
unrelated_metric{source="fixture"} 42
`;

function withTargets(processing: string, deferred: string, typeLines = "") {
  return [
    "# TYPE llamacpp:requests_processing gauge",
    `llamacpp:requests_processing ${processing}`,
    "# TYPE llamacpp:requests_deferred gauge",
    `llamacpp:requests_deferred ${deferred}`,
    typeLines,
  ].filter(Boolean).join("\n");
}

describe("parseLlamaCppActivityMetrics", () => {
  it("parses one unlabelled sample for each documented gauge", () => {
    expect(parseLlamaCppActivityMetrics(FIXTURE)).toEqual({
      state: "observed",
      active: 2,
      queued: 1,
      reason: "ok",
    });
  });

  it("accepts integer-valued decimal and exponent forms", () => {
    expect(parseLlamaCppActivityMetrics(withTargets("0", "2e0"))).toMatchObject({
      state: "observed",
      active: 0,
      queued: 2,
      reason: "ok",
    });
    expect(parseLlamaCppActivityMetrics(withTargets("1.0", "2e1"))).toMatchObject({
      state: "observed",
      active: 1,
      queued: 20,
      reason: "ok",
    });
  });

  it("reports missing required TYPE or sample metrics", () => {
    expect(parseLlamaCppActivityMetrics("")).toEqual({
      state: "unknown",
      active: null,
      queued: null,
      reason: "missing-metrics",
    });
    expect(parseLlamaCppActivityMetrics("# TYPE llamacpp:requests_processing gauge\nllamacpp:requests_processing 1")).toEqual({
      state: "unknown",
      active: null,
      queued: null,
      reason: "missing-metrics",
    });
    expect(parseLlamaCppActivityMetrics([
      "llamacpp:requests_processing 1",
      "llamacpp:requests_processing 2",
      "# TYPE llamacpp:requests_deferred gauge",
      "llamacpp:requests_deferred 0",
    ].join("\n"))).toEqual({
      state: "unknown",
      active: null,
      queued: null,
      reason: "invalid-metrics",
    });
  });

  it("does not substitute duplicate TYPE declarations for a missing sample", () => {
    expect(parseLlamaCppActivityMetrics([
      "# TYPE llamacpp:requests_processing gauge",
      "# TYPE llamacpp:requests_processing gauge",
      "# TYPE llamacpp:requests_deferred gauge",
      "llamacpp:requests_deferred 0",
    ].join("\n"))).toMatchObject({ state: "unknown", active: null, queued: null, reason: "invalid-metrics" });
  });

  it.each([
    ["duplicate processing sample", withTargets("1\nllamacpp:requests_processing 2", "0")],
    ["duplicate deferred sample", withTargets("1", "0\nllamacpp:requests_deferred 2")],
    ["labels", withTargets("1", "0").replace("llamacpp:requests_processing 1", "llamacpp:requests_processing{worker=\"a\"} 1")],
    ["timestamp", withTargets("1 1234567890", "0")],
    ["malformed processing sample", withTargets("not-a-number", "0")],
    ["malformed deferred sample", withTargets("1", "NaN")],
    ["negative value", withTargets("-1", "0")],
    ["fractional value", withTargets("1.5", "0")],
    ["infinite value", withTargets("1", "+Inf")],
    ["unsafe integer", withTargets("9007199254740992", "0")],
    ["incorrect TYPE", withTargets("1", "0", "# TYPE llamacpp:requests_deferred counter")],
    ["duplicate TYPE", withTargets("1", "0", "# TYPE llamacpp:requests_processing gauge")],
    ["malformed duplicate TYPE spacing", withTargets("1", "0", " #  TYPE llamacpp:requests_processing counter")],
  ])("rejects %s", (_label, text) => {
    expect(parseLlamaCppActivityMetrics(text)).toEqual({
      state: "unknown",
      active: null,
      queued: null,
      reason: "invalid-metrics",
    });
  });

  it("ignores unrelated metrics and comments", () => {
    expect(parseLlamaCppActivityMetrics(`${FIXTURE}\n# llamacpp:requests_processing 999\nother_metric 1`)).toMatchObject({
      state: "observed",
      active: 2,
      queued: 1,
      reason: "ok",
    });
  });

  it("rejects bodies over 128 KiB by UTF-8 byte length", () => {
    const body = `${withTargets("1", "0")}\n${"å".repeat(66_000)}`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(128 * 1024);
    expect(parseLlamaCppActivityMetrics(body)).toEqual({
      state: "unknown",
      active: null,
      queued: null,
      reason: "body-too-large",
    });
  });
});
