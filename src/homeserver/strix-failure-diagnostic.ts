/**
 * Bounded, sanitized diagnostics for Strix failures.
 *
 * Error.cause and AggregateError.errors are not enumerable in a reliable way, so
 * this module walks those fields explicitly. The returned object contains only
 * bounded strings and recursively bounded diagnostics; it never retains the
 * original error objects.
 */

export const MAX_FAILURE_DIAGNOSTIC_DEPTH = 8;
export const MAX_FAILURE_DIAGNOSTIC_NODES = 32;
export const MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS = 512;
export const MAX_FAILURE_DIAGNOSTIC_OUTPUT_BYTES = 16 * 1024;

export interface FailureDiagnostic {
  readonly type: string;
  readonly message: string;
  readonly cause?: FailureDiagnostic;
  readonly errors?: readonly FailureDiagnostic[];
  readonly circular?: true;
  readonly truncated?: "depth" | "count" | "output";
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_TYPE_CHARS = 128;

function sanitize(value: string, limit: number): string {
  return Array.from(value.replace(CONTROL_CHARACTERS, " ")).slice(0, limit).join("");
}

function objectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "[unprintable]";
  }
}

function safeProperty(value: object, key: string): { present: boolean; value?: unknown } {
  try {
    if (!(key in value)) return { present: false };
    return { present: true, value: (value as Record<string, unknown>)[key] };
  } catch {
    return { present: true, value: "[unreadable]" };
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function isAggregateError(value: unknown): value is AggregateError {
  try {
    return typeof AggregateError !== "undefined" && value instanceof AggregateError;
  } catch {
    return false;
  }
}

function diagnosticType(value: unknown): string {
  if (isAggregateError(value)) return "AggregateError";
  if (isError(value)) {
    try {
      return typeof value.name === "string" && value.name !== "" ? value.name : "Error";
    } catch {
      return "Error";
    }
  }
  return value === null ? "null" : typeof value;
}

function diagnosticMessage(value: unknown): string {
  if (isError(value)) {
    try { return safeString(value.message); } catch { return "[unreadable message]"; }
  }
  return safeString(value);
}

function truncation(message: string, kind: "depth" | "count"): FailureDiagnostic {
  return { type: "FailureDiagnosticTruncated", message, truncated: kind };
}

function outputBytes(value: FailureDiagnostic): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Remove the least useful tail while retaining the first error and cause branches. */
function pruneForOutput(node: FailureDiagnostic): boolean {
  const errors = node.errors as FailureDiagnostic[] | undefined;
  if (errors !== undefined) {
    for (let index = errors.length - 1; index >= 0; index--) {
      if (pruneForOutput(errors[index]!)) return true;
    }
    if (errors.length > 0) {
      errors.pop();
      (node as { truncated?: "depth" | "count" | "output" }).truncated = "output";
      return true;
    }
  }
  if (node.cause !== undefined && pruneForOutput(node.cause)) return true;
  if (node.cause !== undefined) {
    delete (node as { cause?: FailureDiagnostic }).cause;
    (node as { truncated?: "depth" | "count" | "output" }).truncated = "output";
    return true;
  }
  if (node.message.length > 16) {
    (node as { message: string }).message = node.message.slice(0, Math.floor(node.message.length / 2));
    (node as { truncated?: "depth" | "count" | "output" }).truncated = "output";
    return true;
  }
  return false;
}

function boundOutput(root: FailureDiagnostic): FailureDiagnostic {
  while (outputBytes(root) > MAX_FAILURE_DIAGNOSTIC_OUTPUT_BYTES && pruneForOutput(root)) {
    // Prune deterministically until the serialized diagnostic fits the contract.
  }
  return root;
}

/** Convert an unknown thrown value into a bounded, recursively sanitized diagnostic. */
export function failureDiagnostic(error: unknown): FailureDiagnostic {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (value: unknown, level: number): FailureDiagnostic => {
    if (nodes >= MAX_FAILURE_DIAGNOSTIC_NODES) return truncation("diagnostic node limit reached", "count");
    if (objectLike(value) && seen.has(value)) {
      nodes++;
      return {
        type: sanitize(diagnosticType(value), MAX_TYPE_CHARS),
        message: sanitize(diagnosticMessage(value), MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS),
        circular: true,
      };
    }
    if (level >= MAX_FAILURE_DIAGNOSTIC_DEPTH) {
      nodes++;
      return {
        type: sanitize(diagnosticType(value), MAX_TYPE_CHARS),
        message: sanitize(diagnosticMessage(value), MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS),
        truncated: "depth",
      };
    }

    nodes++;
    if (objectLike(value)) seen.add(value);
    const node: { type: string; message: string; cause?: FailureDiagnostic; errors?: FailureDiagnostic[]; truncated?: "depth" | "count" | "output" } = {
      type: sanitize(diagnosticType(value), MAX_TYPE_CHARS),
      message: sanitize(diagnosticMessage(value), MAX_FAILURE_DIAGNOSTIC_MESSAGE_CHARS),
    };
    if (!objectLike(value)) return node;

    const aggregateErrors = (() => {
      try {
        if (!isAggregateError(value)) return undefined;
        const candidate = (value as { errors?: unknown }).errors;
        return Array.isArray(candidate) ? candidate : [];
      } catch {
        return [];
      }
    })();
    if (aggregateErrors !== undefined) {
      node.errors = [];
      for (const child of aggregateErrors) {
        if (nodes >= MAX_FAILURE_DIAGNOSTIC_NODES) {
          node.truncated = "count";
          break;
        }
        node.errors.push(visit(child, level + 1));
      }
    }

    const cause = safeProperty(value, "cause");
    if (cause.present) {
      if (nodes >= MAX_FAILURE_DIAGNOSTIC_NODES) node.truncated = "count";
      else node.cause = visit(cause.value, level + 1);
    }
    return node;
  };

  return boundOutput(visit(error, 0));
}

export {};
