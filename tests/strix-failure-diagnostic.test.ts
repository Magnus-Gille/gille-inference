import { describe, expect, it } from "vitest";
import {
  failureDiagnostic,
  MAX_FAILURE_DIAGNOSTIC_DEPTH,
  MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_FAILURE_DIAGNOSTIC_NODES,
  MAX_FAILURE_DIAGNOSTIC_OUTPUT_BYTES,
  type FailureDiagnostic,
} from "../src/homeserver/strix-failure-diagnostic.js";

function countNodes(node: FailureDiagnostic): number {
  return 1 + (node.cause === undefined ? 0 : countNodes(node.cause)) +
    (node.errors?.reduce((total, child) => total + countNodes(child), 0) ?? 0);
}

function depth(node: FailureDiagnostic): number {
  return 1 + Math.max(node.cause === undefined ? 0 : depth(node.cause), ...(node.errors?.map(depth) ?? [0]));
}

describe("failureDiagnostic", () => {
  it("retains nested AggregateError entries and Error.cause chains", () => {
    const armFailure = new Error("arm failed", { cause: new Error("backend timeout") });
    const restorationFailure = new Error("restoration failed", { cause: new Error("residency mismatch") });
    const aggregate = new AggregateError([armFailure, restorationFailure], "experiment failed");

    expect(failureDiagnostic(aggregate)).toMatchObject({
      type: "AggregateError",
      message: "experiment failed",
      errors: [
        { type: "Error", message: "arm failed", cause: { type: "Error", message: "backend timeout" } },
        { type: "Error", message: "restoration failed", cause: { type: "Error", message: "residency mismatch" } },
      ],
    });
  });

  it("handles circular causes without recursing forever", () => {
    const error = new Error("circular");
    error.cause = error;

    const diagnostic = failureDiagnostic(error);
    expect(diagnostic.cause).toMatchObject({ circular: true, type: "Error", message: "circular" });
    expect(() => JSON.stringify(diagnostic)).not.toThrow();
  });

  it("sanitizes control characters and bounds message, depth, count, and output", () => {
    let current: Error = new Error(`${"prefix\n\r\t\0\u000b"}${"x".repeat(10_000)}`);
    for (let index = 0; index < MAX_FAILURE_DIAGNOSTIC_DEPTH + 10; index++) {
      current = new Error(`cause-${index}`, { cause: current });
    }
    const aggregate = new AggregateError(
      Array.from({ length: MAX_FAILURE_DIAGNOSTIC_NODES + 10 }, (_, index) => new Error(`entry-${index}`)),
      "aggregate",
    );
    aggregate.cause = current;

    const diagnostic = failureDiagnostic(aggregate);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(countNodes(diagnostic)).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_NODES);
    expect(depth(diagnostic)).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_DEPTH + 1);
    expect(diagnostic.message.length).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_OUTPUT_BYTES);
  });
});
