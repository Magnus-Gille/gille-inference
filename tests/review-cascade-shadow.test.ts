import { describe, expect, it, afterEach } from "vitest";
import {
  DEFAULT_REVIEW_CASCADE_SHADOW,
  resetReviewCascadeShadow,
  reviewCascadeEligible,
  reviewCascadeShadowIdle,
  scheduleReviewCascadeShadow,
  type ReviewCascadeAggregate,
} from "../src/homeserver/review-cascade-shadow.js";

const source = "L1|const id = req.id;\nL2|db.exec(`SELECT * FROM users WHERE id=${id}`);";
const candidate = JSON.stringify({ findings: [{ id: "f1", severity: "high", lineIds: ["L2"], evidence: "db.exec(`SELECT * FROM users WHERE id=${id}`);", claim: "SQL injection" }] });
const decision = JSON.stringify({ adjudications: [{ findingId: "f1", decision: "confirm", rationale: "Interpolation reaches db.exec." }] });
const cfg = { ...DEFAULT_REVIEW_CASCADE_SHADOW, mode: "shadow" as const, gptModel: "gpt-oss-120b", qwenModel: "qwen35-122b-a10b" };

afterEach(() => resetReviewCascadeShadow());

describe("review cascade shadow lane", () => {
  it("rejects guests and malformed source before any model call", async () => {
    expect(reviewCascadeEligible({ config: cfg, job: { taskType: "code-review", ownerContent: false, source }, queueDepth: 0, running: 0 })).toMatchObject({ eligible: false });
    let calls = 0;
    scheduleReviewCascadeShadow({ taskType: "code-review", ownerContent: true, source: "not-labelled" }, {
      config: cfg, queueDepth: () => 0,
      infer: async () => { calls++; return { ok: true, response: candidate }; },
      recordAggregate: () => undefined, recordOwnerDetails: () => undefined,
    });
    await reviewCascadeShadowIdle();
    expect(calls).toBe(0);
  });

  it("runs GPT recall then Qwen adjudication without exposing a caller-visible result", async () => {
    const calls: string[] = [];
    const totals: ReviewCascadeAggregate[] = [];
    const details: unknown[] = [];
    const returned = scheduleReviewCascadeShadow({ taskType: "code-review", ownerContent: true, source }, {
      config: cfg, queueDepth: () => 0,
      infer: async (model) => { calls.push(model); return { ok: true, response: model === cfg.gptModel ? candidate : decision, latencyMs: 10 }; },
      recordAggregate: (row) => totals.push(row), recordOwnerDetails: (row) => details.push(row),
    });
    expect(returned).toBeUndefined();
    await reviewCascadeShadowIdle();
    expect(calls).toEqual([cfg.gptModel, cfg.qwenModel]);
    expect(totals).toEqual([expect.objectContaining({ terminal: "completed", candidateCount: 1, confirmed: 1, gpuOccupancyMs: 20 })]);
    expect(details).toHaveLength(1);
  });

  it("never runs while real delegate work is queued", async () => {
    let calls = 0;
    scheduleReviewCascadeShadow({ taskType: "code-review", ownerContent: true, source }, {
      config: cfg, queueDepth: () => 1,
      infer: async () => { calls++; return { ok: true, response: candidate }; },
      recordAggregate: () => undefined, recordOwnerDetails: () => undefined,
    });
    await reviewCascadeShadowIdle();
    expect(calls).toBe(0);
  });
});
