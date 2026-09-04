import { describe, expect, it } from "vitest";
import { PROBES } from "../src/homeserver/probes.js";

const GROUNDED_TESTS = String.raw`
export function runTests(extractUsage: (events: unknown[], fromIso: string) => unknown[]): void {
  const fromIso = "2026-09-03T10:00:00.000Z";
  const events = [
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, reasoning_output_tokens: 7 } },
        session_meta: { session_id: "session-b" },
        turn_context: { call_id: "call-2", source: { subagent: { thread_spawn: "spawn-b" } } },
        timestamp: "2026-09-03T10:00:02.000Z",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 80, cached_input_tokens: 20, reasoning_output_tokens: 3 } },
        session_meta: { session_id: "session-a" },
        turn_context: { call_id: "call-1", source: { subagent: { thread_spawn: "spawn-a" } } },
        timestamp: "2026-09-03T10:00:01.000Z",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 2 } },
        session_meta: { session_id: "session-a" },
        turn_context: { call_id: "call-3", source: { subagent: { thread_spawn: "spawn-c" } } },
        timestamp: "2026-09-03T10:00:03.000Z",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 999, cached_input_tokens: 0, reasoning_output_tokens: 0 } },
        session_meta: { session_id: "old-session" },
        turn_context: { call_id: "old-call", source: { subagent: { thread_spawn: "old-spawn" } } },
        timestamp: "2026-09-03T09:59:59.000Z",
      },
    },
  ];
  const got = extractUsage(events, fromIso) as Array<Record<string, unknown>>;
  if (got.length !== 3) throw new Error("expected one record per call after the timestamp filter");
  if (got.map((record) => record.call_id).join(",") !== "call-1,call-2,call-3") {
    throw new Error("expected deterministic timestamp ordering");
  }
  const first = got[0]!;
  if (first.session_id !== "session-a" || first.fresh_input_tokens !== 60 || first.cached_input_tokens !== 20) {
    throw new Error("expected fresh/cache token fields from payload.info.last_token_usage");
  }
  if (first.reasoning_output_tokens !== 3 || first.source_thread_spawn !== "spawn-a") {
    throw new Error("expected reasoning tokens and source.subagent.thread_spawn");
  }
  if (got.some((record) => "input_tokens" in record)) throw new Error("legacy record.input_tokens is forbidden");
}
`;

// Sanitized representative of cl-20260903-2688c29c: it invents top-level event/info,
// collapses calls by session, and asserts the nonexistent record.input_tokens field.
const HISTORICAL_UNGROUNDED_TESTS = String.raw`
export function runTests(extractUsage: (events: unknown[], fromIso: string) => unknown[]): void {
  const events = [{ event: "token_count", info: { input_tokens: 100 }, session_id: "s1" }];
  const got = extractUsage(events, "2026-09-03T10:00:00.000Z") as Array<Record<string, unknown>>;
  if (got.length !== 1) throw new Error("expected one record per session");
  if (got[0]?.input_tokens !== 100) throw new Error("expected input_tokens");
}
`;

describe("unit-test-gen schema-grounding regression (#260)", () => {
  const probe = PROBES.find((candidate) => candidate.id === "test-usage-event-schema");

  it("publishes a production-shaped unit-test-gen fixture with a deterministic grounding gate", () => {
    expect(probe).toBeDefined();
    expect(probe?.taskType).toBe("unit-test-gen");
    expect(probe?.verifierName).toBe("requiredAnchors+tsGate(schema-mutants-v1)");
  });

  it("rejects the sanitized historical fabricated schema with named missing-contract diagnostics", async () => {
    const result = await probe!.verifier(HISTORICAL_UNGROUNDED_TESTS);
    expect(result.outcome).toBe("fail");
    expect(result.notes).toContain("missing contract anchors");
    expect(result.notes).toContain("payload.info.last_token_usage");
    expect(result.notes).toContain("source.subagent.thread_spawn");
  });

  it("passes grounded tests that reject every nesting, cardinality, field, filtering, and ordering mutant", async () => {
    const result = await probe!.verifier(GROUNDED_TESTS);
    expect(result, result.notes).toMatchObject({ outcome: "pass", score: 1 });
  });
});
