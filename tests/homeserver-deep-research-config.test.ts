import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadDeepResearchConfig,
  setDeepResearchConfig,
  resetDeepResearchConfig,
} from "../src/homeserver/deep-research-config.js";

/** Env keys this suite touches — saved/restored so cases don't leak into each other. */
const KEYS = [
  "RESEARCH_PLANNER_MODEL",
  "RESEARCH_DISTILL_MODEL",
  "RESEARCH_SYNTH_MODEL",
  "RESEARCH_BRAIN",
  "RESEARCH_MAX_ITERS",
  "RESEARCH_CITATION_THRESHOLD",
  "SEARCH_PROVIDER",
  "READER_THIN_CHARS",
  "RESEARCH_GATEWAY_URL",
  "RESEARCH_SYNTH_TEMP",
  "RESEARCH_SYNTH_MIN_TOKENS",
  "RESEARCH_PLANNER_TEMP",
  "RESEARCH_SYNTH_STRATEGY",
  "RESEARCH_SYNTH_REPAIR_ROUNDS",
  "RESEARCH_SYNTH_ATOMIC",
  "RESEARCH_AGENT_DIALECT",
  "RESEARCH_AGENT_AUTOCITE",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetDeepResearchConfig();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetDeepResearchConfig();
});

describe("deep-research config", () => {
  it("uses the M5-tuned defaults when env is unset", () => {
    const c = loadDeepResearchConfig();
    expect(c.plannerModel).toBe("qwen3-coder-next-80b");
    expect(c.distillModel).toBe("mellum");
    expect(c.synthModel).toBe("qwen3-coder-next-80b");
    expect(c.brain).toBe("local");
    expect(c.maxIters).toBe(3);
    expect(c.searchProvider).toBe("searxng");
    expect(c.searchFallbackProvider).toBe("brave");
    expect(c.readerProvider).toBe("trafilatura");
    expect(c.citationMatchThreshold).toBe(0.8);
  });

  it("reads model + provider overrides from env", () => {
    process.env["RESEARCH_PLANNER_MODEL"] = "tongyi-dr";
    process.env["RESEARCH_DISTILL_MODEL"] = "qwen3-30b-a3b";
    process.env["SEARCH_PROVIDER"] = "brave";
    resetDeepResearchConfig();
    const c = loadDeepResearchConfig();
    expect(c.plannerModel).toBe("tongyi-dr");
    expect(c.distillModel).toBe("qwen3-30b-a3b");
    expect(c.searchProvider).toBe("brave");
  });

  it("maps RESEARCH_BRAIN only to the two valid modes", () => {
    process.env["RESEARCH_BRAIN"] = "hybrid";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().brain).toBe("hybrid");

    process.env["RESEARCH_BRAIN"] = "nonsense";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().brain).toBe("local");
  });

  it("clamps the citation threshold into [0,1] and floors maxIters at 1", () => {
    process.env["RESEARCH_CITATION_THRESHOLD"] = "1.7";
    process.env["RESEARCH_MAX_ITERS"] = "0";
    resetDeepResearchConfig();
    const c = loadDeepResearchConfig();
    expect(c.citationMatchThreshold).toBe(1);
    expect(c.maxIters).toBe(1);
  });

  it("falls back to the default for a non-numeric numeric env", () => {
    process.env["READER_THIN_CHARS"] = "not-a-number";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().readerThinChars).toBe(500);
  });

  it("strips a trailing slash from the gateway URL", () => {
    process.env["RESEARCH_GATEWAY_URL"] = "http://127.0.0.1:8091/v1/";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().gatewayUrl).toBe("http://127.0.0.1:8091/v1");
  });

  it("defaults per-role temperature and min-token floors to 0 (current behavior preserved)", () => {
    const c = loadDeepResearchConfig();
    expect(c.plannerTemp).toBe(0);
    expect(c.distillTemp).toBe(0);
    expect(c.synthTemp).toBe(0);
    expect(c.plannerMinTokens).toBe(0);
    expect(c.distillMinTokens).toBe(0);
    expect(c.synthMinTokens).toBe(0);
  });

  it("reads per-role temperature + min-token floors from env (reasoning-model support)", () => {
    process.env["RESEARCH_SYNTH_TEMP"] = "0.6";
    process.env["RESEARCH_SYNTH_MIN_TOKENS"] = "8000";
    resetDeepResearchConfig();
    const c = loadDeepResearchConfig();
    expect(c.synthTemp).toBe(0.6);
    expect(c.synthMinTokens).toBe(8000);
  });

  it("defaults synthStrategy to oneshot and reads reground from env", () => {
    expect(loadDeepResearchConfig().synthStrategy).toBe("oneshot");
    expect(loadDeepResearchConfig().synthRepairRounds).toBe(1);
    process.env["RESEARCH_SYNTH_STRATEGY"] = "reground";
    process.env["RESEARCH_SYNTH_REPAIR_ROUNDS"] = "2";
    resetDeepResearchConfig();
    const c = loadDeepResearchConfig();
    expect(c.synthStrategy).toBe("reground");
    expect(c.synthRepairRounds).toBe(2);
  });

  it("defaults synthAtomic off and reads it from env", () => {
    expect(loadDeepResearchConfig().synthAtomic).toBe(false);
    process.env["RESEARCH_SYNTH_ATOMIC"] = "true";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().synthAtomic).toBe(true);
  });

  it("defaults agentDialect to tongyi and maps the env to the two valid dialects", () => {
    expect(loadDeepResearchConfig().agentDialect).toBe("tongyi");
    process.env["RESEARCH_AGENT_DIALECT"] = "generic";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().agentDialect).toBe("generic");
    process.env["RESEARCH_AGENT_DIALECT"] = "nonsense";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().agentDialect).toBe("tongyi");
  });

  it("setDeepResearchConfig overlays a partial for tests", () => {
    const c = setDeepResearchConfig({ maxIters: 7, brain: "hybrid" });
    expect(c.maxIters).toBe(7);
    expect(c.brain).toBe("hybrid");
    // unrelated fields keep their defaults
    expect(c.distillModel).toBe("mellum");
  });

  it("agentAutoCite defaults ON for tongyi, OFF for generic (#46), and env overrides both", () => {
    // Default dialect tongyi → autocite on.
    expect(loadDeepResearchConfig().agentAutoCite).toBe(true);
    // generic dialect → autocite off.
    process.env["RESEARCH_AGENT_DIALECT"] = "generic";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().agentAutoCite).toBe(false);
    // Explicit env override wins over the dialect default (force ON for generic).
    process.env["RESEARCH_AGENT_AUTOCITE"] = "true";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().agentAutoCite).toBe(true);
    // …and force OFF for tongyi.
    process.env["RESEARCH_AGENT_DIALECT"] = "tongyi";
    process.env["RESEARCH_AGENT_AUTOCITE"] = "false";
    resetDeepResearchConfig();
    expect(loadDeepResearchConfig().agentAutoCite).toBe(false);
  });

  it("setDeepResearchConfig({agentDialect:'generic'}) re-derives agentAutoCite OFF (no stale tongyi default)", () => {
    // Reproduces the Codex finding: a dialect override via the CLI path must flip the autocite
    // default too, not inherit the loaded tongyi default.
    delete process.env["RESEARCH_AGENT_AUTOCITE"];
    resetDeepResearchConfig();
    const c = setDeepResearchConfig({ agentDialect: "generic" });
    expect(c.agentDialect).toBe("generic");
    expect(c.agentAutoCite).toBe(false);
    // An explicit agentAutoCite in the partial still wins.
    const c2 = setDeepResearchConfig({ agentDialect: "generic", agentAutoCite: true });
    expect(c2.agentAutoCite).toBe(true);
    // An explicit env override is respected even when the dialect is overridden.
    process.env["RESEARCH_AGENT_AUTOCITE"] = "true";
    resetDeepResearchConfig();
    const c3 = setDeepResearchConfig({ agentDialect: "generic" });
    expect(c3.agentAutoCite).toBe(true);
  });
});
