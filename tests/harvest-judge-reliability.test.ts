import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildJudgeBody,
  classifyJudgeCompletion,
  escalateJudgeMaxTokens,
  capJudgeMaxTokens,
  shouldWriteVerdict,
  HARVEST_JUDGE_MAX_TOKENS_DEFAULT,
  HARVEST_JUDGE_MAX_TOKENS_CAP,
  HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT,
} from "../src/homeserver/harvest.js";
import { loadConfig, resetConfig, DEFAULT_HARVEST_EXCLUDED_TASK_TYPES } from "../src/homeserver/config.js";
import { judgeWithRetry, JudgeStarvedError, judgeRetryStats } from "../scripts/harvest-verdicts.js";

/**
 * Root-cause coverage for the 2026-07-08/09 nightly harvest "judge-err: empty judge completion"
 * instability (the HOLD blocker on HARVEST_MODE=on).
 *
 * Measured on the box (owner_request_log row #6132 replayed against loopback llama-swap):
 *   max_tokens=600  → finish_reason:"length", usage.completion_tokens:600, content:"" —
 *                     gpt-oss-120b is a harmony/REASONING model; its reasoning_content ate the
 *                     entire 600-token budget before any content was emitted.
 *   max_tokens=2000 → finish_reason:"stop", completion_tokens:709, valid verdict JSON.
 *   row #6127       → needed 1155 completion tokens for a valid verdict.
 *
 * The 2026-07-06 calibration (0% error, 22/22) did not catch this because the control set's
 * prompts are <=171 chars — real traffic prompts run 5-24 KB and need far more reasoning budget.
 * The old retry loop retried "empty judge completion" at the SAME 600 budget: reasoning length at
 * temperature 0 is near-deterministic, so every retry starved identically.
 */

describe("judge token budget (starvation root cause)", () => {
  it("defaults the judge call's max_tokens to a reasoning-adequate budget, not 600", () => {
    // 600 starved real traffic (observed reasoning need up to 1155 tokens + headroom).
    expect(HARVEST_JUDGE_MAX_TOKENS_DEFAULT).toBeGreaterThanOrEqual(4000);
    expect(buildJudgeBody("gpt-oss-120b", "sys", "usr").max_tokens).toBe(HARVEST_JUDGE_MAX_TOKENS_DEFAULT);
  });

  it("still respects an explicit maxTokens override", () => {
    expect(buildJudgeBody("m", "s", "u", { maxTokens: 128 }).max_tokens).toBe(128);
  });
});

describe("classifyJudgeCompletion (empty-content-with-length-finish is starvation, not a generic error)", () => {
  it("classifies the EXACT observed box failure shape as starved", () => {
    // Verbatim shape from the live repro of nightly judge-err row #6132 (2026-07-09 run):
    const resp = {
      choices: [
        {
          finish_reason: "length",
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "We need to evaluate if the assistant's answer meets the task…",
          },
        },
      ],
      usage: { completion_tokens: 600, prompt_tokens: 4113, total_tokens: 4713 },
    };
    const out = classifyJudgeCompletion(resp);
    expect(out.kind).toBe("starved");
    if (out.kind === "starved") {
      expect(out.detail).toContain("length");
      expect(out.detail).toContain("600");
    }
  });

  it("classifies truncated (unparseable) JSON at the length boundary as starved — the parse-fail case", () => {
    const resp = {
      choices: [{ finish_reason: "length", message: { content: '{"verdict":"pa' } }],
      usage: { completion_tokens: 600 },
    };
    expect(classifyJudgeCompletion(resp).kind).toBe("starved");
  });

  it("treats a COMPLETE verdict that happens to finish at the length boundary as ok (no wasted retry)", () => {
    const resp = {
      choices: [
        { finish_reason: "length", message: { content: '{"verdict":"pass","score":1,"reason":"ok"}' } },
      ],
    };
    const out = classifyJudgeCompletion(resp);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toContain('"pass"');
  });

  it("classifies a normal stop-finish completion as ok", () => {
    const resp = {
      choices: [
        { finish_reason: "stop", message: { content: '{"verdict":"fail","score":0.2,"reason":"wrong"}' } },
      ],
    };
    expect(classifyJudgeCompletion(resp).kind).toBe("ok");
  });

  it("classifies empty content WITHOUT a length finish as the generic empty case", () => {
    expect(classifyJudgeCompletion({ choices: [{ finish_reason: "stop", message: { content: "" } }] }).kind).toBe(
      "empty"
    );
    expect(classifyJudgeCompletion({ choices: [{ finish_reason: "stop", message: {} }] }).kind).toBe("empty");
    expect(classifyJudgeCompletion({}).kind).toBe("empty");
  });
});

describe("escalateJudgeMaxTokens (a starved retry must retry with a BIGGER budget)", () => {
  it("doubles the budget", () => {
    expect(escalateJudgeMaxTokens(4000)).toBe(8000);
  });

  it("caps at HARVEST_JUDGE_MAX_TOKENS_CAP", () => {
    expect(escalateJudgeMaxTokens(HARVEST_JUDGE_MAX_TOKENS_CAP)).toBe(HARVEST_JUDGE_MAX_TOKENS_CAP);
    expect(escalateJudgeMaxTokens(HARVEST_JUDGE_MAX_TOKENS_CAP - 1)).toBe(HARVEST_JUDGE_MAX_TOKENS_CAP);
    expect(HARVEST_JUDGE_MAX_TOKENS_CAP).toBeGreaterThanOrEqual(2 * HARVEST_JUDGE_MAX_TOKENS_DEFAULT);
  });

  it("never returns a smaller or non-finite budget", () => {
    expect(escalateJudgeMaxTokens(100)).toBeGreaterThan(100);
    expect(Number.isFinite(escalateJudgeMaxTokens(HARVEST_JUDGE_MAX_TOKENS_CAP))).toBe(true);
  });

  it("never LOWERS an explicit above-cap override (codex review finding #1)", () => {
    // An operator who sets HARVEST_JUDGE_MAX_TOKENS=20000 must not have the first starved
    // retry silently reduce it to the cap — that would make the override worse after a failure.
    expect(escalateJudgeMaxTokens(HARVEST_JUDGE_MAX_TOKENS_CAP + 4000)).toBe(HARVEST_JUDGE_MAX_TOKENS_CAP + 4000);
  });
});

describe("judgeWithRetry (the retry loop itself — codex review finding #2)", () => {
  beforeEach(() => {
    judgeRetryStats.starvedEscalations = 0;
  });

  /** Fake judgeOnce: consumes `script` outcomes in order; records the budget of every attempt. */
  const scripted = (script: ("starved" | "transient" | "ok")[], budgets: number[]) => {
    let i = 0;
    return async (maxTokens: number): Promise<string> => {
      budgets.push(maxTokens);
      const step = script[Math.min(i++, script.length - 1)];
      if (step === "starved") throw new JudgeStarvedError(`judge starved (max_tokens=${maxTokens})`);
      if (step === "transient") throw new Error("HTTP 503: swap in progress");
      return '{"verdict":"pass","score":1,"reason":"ok"}';
    };
  };
  const noSleep = async (): Promise<void> => {};

  it("starved → ok retries once with a DOUBLED budget", async () => {
    const budgets: number[] = [];
    const out = await judgeWithRetry(scripted(["starved", "ok"], budgets), {
      initialMaxTokens: 4000,
      sleep: noSleep,
    });
    expect(out).toContain('"pass"');
    expect(budgets).toEqual([4000, 8000]);
    expect(judgeRetryStats.starvedEscalations).toBe(1);
  });

  it("a transient error retries at the SAME budget; a later starvation still escalates", async () => {
    const budgets: number[] = [];
    await judgeWithRetry(scripted(["transient", "starved", "ok"], budgets), {
      initialMaxTokens: 4000,
      sleep: noSleep,
    });
    expect(budgets).toEqual([4000, 4000, 8000]);
  });

  it("starved AT the cap fails fast — no pointless same-budget retry (codex review finding #1)", async () => {
    const budgets: number[] = [];
    await expect(
      judgeWithRetry(scripted(["starved"], budgets), {
        initialMaxTokens: HARVEST_JUDGE_MAX_TOKENS_CAP,
        sleep: noSleep,
      })
    ).rejects.toThrow(/starved/);
    expect(budgets).toEqual([HARVEST_JUDGE_MAX_TOKENS_CAP]); // exactly one attempt
    expect(judgeRetryStats.starvedEscalations).toBe(0);
  });

  it("starved ABOVE the cap fails fast without lowering the operator's override", async () => {
    const budgets: number[] = [];
    await expect(
      judgeWithRetry(scripted(["starved"], budgets), {
        initialMaxTokens: HARVEST_JUDGE_MAX_TOKENS_CAP + 4000,
        sleep: noSleep,
      })
    ).rejects.toThrow(/starved/);
    expect(budgets).toEqual([HARVEST_JUDGE_MAX_TOKENS_CAP + 4000]);
  });

  it("exhausted transient retries surface the last error", async () => {
    const budgets: number[] = [];
    await expect(
      judgeWithRetry(scripted(["transient", "transient", "transient", "transient"], budgets), {
        retries: 3,
        initialMaxTokens: 4000,
        sleep: noSleep,
      })
    ).rejects.toThrow(/HTTP 503/);
    expect(budgets).toEqual([4000, 4000, 4000, 4000]);
  });

  it("a non-transient error is not retried", async () => {
    const budgets: number[] = [];
    let calls = 0;
    await expect(
      judgeWithRetry(
        async (mt: number) => {
          budgets.push(mt);
          calls++;
          throw new Error("HTTP 401: unauthorized");
        },
        { initialMaxTokens: 4000, sleep: noSleep }
      )
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("with inputChars, starvation escalation is capped by the context window instead of overflowing it (agy review)", async () => {
    // 202 KB of judge input (context + task + answer) ≈ 57,715 tokens estimated — the 65,536-token
    // window has ~7,565 tokens of completion room. Escalating 4000 → 8000 → 16000 uncapped would
    // blow the window on exactly the long rows #197 exists to grade.
    const budgets: number[] = [];
    await expect(
      judgeWithRetry(scripted(["starved", "starved", "starved"], budgets), {
        initialMaxTokens: 4000,
        inputChars: 202_000,
        sleep: noSleep,
      })
    ).rejects.toThrow(/starved/);
    const room = capJudgeMaxTokens(Number.MAX_SAFE_INTEGER, 202_000);
    // First attempt at 4000 (fits), second at the capped room; a third attempt would repeat the
    // same capped budget — deterministic re-starvation — so it fails fast instead.
    expect(budgets).toEqual([4000, room]);
    expect(room).toBeLessThan(8000);
  });
});

describe("capJudgeMaxTokens (agy review: input + completion must fit the judge's serving window)", () => {
  it("leaves the requested budget alone when the input is small", () => {
    expect(capJudgeMaxTokens(16_000, 1_000)).toBe(16_000);
  });

  it("caps the budget to the remaining window room on large inputs", () => {
    const capped = capJudgeMaxTokens(16_000, 202_000);
    expect(capped).toBeLessThan(8_000);
    // estimated input tokens + capped completion stays inside the window
    expect(Math.ceil(202_000 / 3.5) + capped).toBeLessThanOrEqual(HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT);
  });

  it("never returns a non-positive budget even when the input alone exceeds the window", () => {
    const capped = capJudgeMaxTokens(4_000, 200_000);
    expect(capped).toBeGreaterThan(0); // the call may still fail server-side → judge-err (skipped row), never a 0-token request
  });

  it("never raises a smaller explicit request", () => {
    expect(capJudgeMaxTokens(600, 202_000)).toBe(600);
  });

  it("respects a custom window size", () => {
    expect(capJudgeMaxTokens(16_000, 1_000, 8_192)).toBeLessThan(8_192);
  });
});

describe("shouldWriteVerdict ('other'-row noise must not teach routing when harvest flips on)", () => {
  it("excludes an excluded task type from verdict-WRITING mode=on", () => {
    expect(shouldWriteVerdict("other", "on", ["other"])).toBe(false);
  });

  it("still allows the excluded type in shadow mode (shadow stats keep flowing)", () => {
    expect(shouldWriteVerdict("other", "shadow", ["other"])).toBe(true);
  });

  it("allows non-excluded task types in mode=on", () => {
    expect(shouldWriteVerdict("code-implement", "on", ["other"])).toBe(true);
    expect(shouldWriteVerdict("qa-factual", "on", ["other"])).toBe(true);
  });

  it("an empty exclusion list disables the gate entirely", () => {
    expect(shouldWriteVerdict("other", "on", [])).toBe(true);
  });
});

describe("harvestExcludedTaskTypes config knob (HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES)", () => {
  const KEY = "HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
    resetConfig();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    resetConfig();
  });

  it("defaults to the broad catch-all bucket ['other'] when unset (the SAFE default)", () => {
    expect(DEFAULT_HARVEST_EXCLUDED_TASK_TYPES).toEqual(["other"]);
    expect(loadConfig().harvestExcludedTaskTypes).toEqual(["other"]);
  });

  it("set to empty string disables the exclusion (operator opt-out)", () => {
    process.env[KEY] = "";
    resetConfig();
    expect(loadConfig().harvestExcludedTaskTypes).toEqual([]);
  });

  it("parses a CSV override into a trimmed list", () => {
    process.env[KEY] = "other, qa-factual";
    resetConfig();
    expect(loadConfig().harvestExcludedTaskTypes).toEqual(["other", "qa-factual"]);
  });
});
