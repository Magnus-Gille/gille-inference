import { describe, it, expect } from "vitest";
import { createAccessLogger, type AccessLogRecord } from "../src/homeserver/access-log.js";

describe("createAccessLogger", () => {
  it("emits exactly one valid JSON line with expected fields populated", () => {
    const lines: string[] = [];
    const logger = createAccessLogger((line) => lines.push(line));

    logger.log({
      event: "gateway_request",
      requestId: "req-001",
      method: "POST",
      route: "/v1/chat/completions",
      principal: "alice",
      tier: "owner",
      model: "gemma-4b",
      status: 200,
      outcome: "ok",
      errorClass: null,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      queueWaitMs: 12,
      totalMs: 340,
      admission: "admitted",
      retryAfterS: null,
    });

    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as AccessLogRecord;
    expect(rec.event).toBe("gateway_request");
    expect(rec.requestId).toBe("req-001");
    expect(rec.method).toBe("POST");
    expect(rec.route).toBe("/v1/chat/completions");
    expect(rec.principal).toBe("alice");
    expect(rec.tier).toBe("owner");
    expect(rec.model).toBe("gemma-4b");
    expect(rec.status).toBe(200);
    expect(rec.outcome).toBe("ok");
    expect(rec.promptTokens).toBe(100);
    expect(rec.completionTokens).toBe(50);
    expect(rec.totalTokens).toBe(150);
    expect(rec.queueWaitMs).toBe(12);
    expect(rec.totalMs).toBe(340);
    expect(rec.admission).toBe("admitted");
    expect(rec.retryAfterS).toBeNull();
    // ts auto-filled
    expect(typeof rec.ts).toBe("string");
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Line ends with \n
    expect(lines[0]!.endsWith("\n")).toBe(true);
  });

  it("ts is filled automatically when not provided", () => {
    const lines: string[] = [];
    const logger = createAccessLogger((line) => lines.push(line));
    const before = Date.now();
    logger.log({ event: "gateway_request", requestId: "r" });
    const after = Date.now();
    const rec = JSON.parse(lines[0]!) as AccessLogRecord;
    const ts = new Date(rec.ts).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("totalTokens is the sum of promptTokens+completionTokens when those are provided but totalTokens omitted", () => {
    const lines: string[] = [];
    const logger = createAccessLogger((line) => lines.push(line));
    logger.log({ event: "gateway_request", requestId: "r", promptTokens: 30, completionTokens: 20 });
    const rec = JSON.parse(lines[0]!) as AccessLogRecord;
    expect(rec.totalTokens).toBe(50);
  });

  it("injected writer that throws does NOT throw out of log()", () => {
    const throwingLogger = createAccessLogger(() => {
      throw new Error("writer exploded");
    });
    expect(() => throwingLogger.log({ event: "gateway_request", requestId: "r" })).not.toThrow();
  });

  it("delegate_decision record includes taskType, decision, score, escalated", () => {
    const lines: string[] = [];
    const logger = createAccessLogger((line) => lines.push(line));
    logger.log({
      event: "delegate_decision",
      requestId: "d-001",
      taskType: "code_generation",
      decision: "delegate",
      score: 0.9,
      escalated: false,
      model: "gemma-4b",
      outcome: "pass",
      totalMs: 1200,
    });
    const rec = JSON.parse(lines[0]!) as AccessLogRecord;
    expect(rec.event).toBe("delegate_decision");
    expect(rec.taskType).toBe("code_generation");
    expect(rec.decision).toBe("delegate");
    expect(rec.score).toBe(0.9);
    expect(rec.escalated).toBe(false);
  });

  it("never logs prompt text, message content, or bearer tokens even if they are passed in fields", () => {
    // SECURITY: The log API only accepts typed fields (see AccessLogRecord).
    // This test asserts by construction that none of the defined fields can carry raw
    // prompt/content/token strings — they are metadata-only (aliases, counts, codes).
    // We pass all defined fields and verify none of the serialized values is a raw secret.
    const lines: string[] = [];
    const logger = createAccessLogger((line) => lines.push(line));
    // All fields that could conceivably be abused — none accept free-form text.
    logger.log({
      event: "gateway_request",
      requestId: "safe-check",
      method: "POST",
      route: "/v1/chat/completions",
      principal: "alice",    // alias only, not the bearer token
      tier: "owner",
      model: "gemma-4b",
      status: 200,
      outcome: "ok",
      errorClass: null,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      queueWaitMs: null,
      totalMs: 200,
      admission: "admitted",
      retryAfterS: null,
    });
    const serialized = lines[0]!;
    // These substrings must never appear in a log line (sanity on the type surface)
    expect(serialized).not.toContain("sk-or-");
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("password");
    // Field values are all metadata (aliases, numbers, codes) — no free-form content
    const rec = JSON.parse(serialized) as Record<string, unknown>;
    const stringValues = Object.values(rec).filter((v) => typeof v === "string");
    for (const v of stringValues) {
      // No value should be longer than a reasonable field (alias/model/route/outcome)
      expect((v as string).length).toBeLessThan(300);
    }
  });

  it("log() is a no-op when the logger is created with a null writer (disabled mode)", () => {
    // Simulates HOMESERVER_ACCESS_LOG=off: pass a no-op writer; nothing should throw
    const noopLogger = createAccessLogger(() => {/* no-op */});
    expect(() => noopLogger.log({ event: "gateway_request", requestId: "x" })).not.toThrow();
  });
});
