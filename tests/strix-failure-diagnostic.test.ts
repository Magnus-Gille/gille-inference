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

  it("sanitizes control characters and bounds a long Unicode message", () => {
    const diagnostic = failureDiagnostic(new Error(`${"prefix\n\r\t\0\u000b"}${"é".repeat(10_000)}`));
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(diagnostic.message.length).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_OUTPUT_BYTES);
  });

  it("bounds a deep cause chain", () => {
    let current: Error = new Error("leaf");
    for (let index = 0; index < MAX_FAILURE_DIAGNOSTIC_DEPTH + 10; index++) {
      current = new Error(`cause-${index}`, { cause: current });
    }

    const diagnostic = failureDiagnostic(current);
    expect(depth(diagnostic)).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_DEPTH + 1);
    expect(JSON.stringify(diagnostic)).toContain('"truncated":"depth"');
  });

  it("bounds aggregate error count", () => {
    const diagnostic = failureDiagnostic(new AggregateError(
      Array.from({ length: MAX_FAILURE_DIAGNOSTIC_NODES + 10 }, (_, index) => new Error(`entry-${index}`)),
      "aggregate",
    ));

    expect(countNodes(diagnostic)).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_NODES);
    expect(diagnostic.truncated).toBe("count");
  });

  it("prunes a large diagnostic to the serialized output bound", () => {
    const diagnostic = failureDiagnostic(new AggregateError(
      Array.from({ length: MAX_FAILURE_DIAGNOSTIC_NODES - 1 }, () => new Error("x".repeat(MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS))),
      "aggregate",
    ));
    const serialized = JSON.stringify(diagnostic);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_FAILURE_DIAGNOSTIC_OUTPUT_BYTES);
    expect(serialized).toContain('"truncated":"output"');
  });

  it("handles throwing and non-string messages plus revoked Error proxies", () => {
    const throwingMessage = new Error("ignored");
    Object.defineProperty(throwingMessage, "message", { configurable: true, get: () => { throw new Error("getter failed"); } });
    const numericMessage = new Error("ignored");
    Object.defineProperty(numericMessage, "message", { configurable: true, value: 503 });
    const revoked = Proxy.revocable(new Error("revoked"), {});
    revoked.revoke();

    expect(failureDiagnostic(throwingMessage).message).toBe("[unreadable message]");
    expect(failureDiagnostic(numericMessage).message).toBe("503");
    expect(() => failureDiagnostic(revoked.proxy)).not.toThrow();
  });
});
