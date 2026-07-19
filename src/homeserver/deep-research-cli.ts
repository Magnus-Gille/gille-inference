/**
 * Deep-research CLI driver.
 *
 *   tsx src/homeserver/deep-research-cli.ts run --query "..." [--depth quick|thorough]
 *                                              [--brain local|hybrid] [--sensitive] [--out DIR]
 *
 * This is the headless entry Hugin invokes over SSH (design §6c). It is the COMPOSITION ROOT:
 * it builds the real adapters (gateway/hybrid OpenAI clients, search + reader providers) from
 * `DeepResearchConfig`, runs the pipeline, writes `report.md` + `popular.md` + `meta.json`, and
 * (by default) records every sub-step to the capability ledger so the box learns which local
 * model does which research role. The pipeline itself (`deep-research.ts`) stays pure/injectable.
 */

import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  loadDeepResearchConfig,
  setDeepResearchConfig,
  type DeepResearchConfig,
  type AgentDialect,
} from "./deep-research-config.js";
import { runResearch } from "./deep-research.js";
import { runAgentResearch } from "./deep-research-agent.js";
import { makeSearchProvider } from "./search-provider.js";
import { makeReader } from "./reader.js";
import { recordDelegation } from "./ledger.js";
import type {
  ChatFn,
  ResearchDeps,
  ResearchRequest,
  ResearchResult,
  BrainMode,
  ResearchDepth,
} from "./deep-research-types.js";

/** Which pipeline drives the run: the deterministic 8-stage pipeline, or the model-driven ReAct loop. */
export type ResearchMode = "deterministic" | "agent";

// ─── Model-call adapter (gateway-local default; frontier API for hybrid) ─────────

/**
 * One OpenAI-compatible client → a bounded `ChatFn`. `temperature` defaults to 0 (deterministic),
 * which suits the recommended NON-thinking roster (mellum, qwen3-coder-next-80b). NOTE: a thinking
 * MoE model (e.g. qwen35-a3b) loops degenerately at temp=0 — set its stage temperature > 0 if you
 * swap one in (cartography finding, docs/m5-cartography-report-2026-06-18.md).
 */
export function makeChatFn(baseUrl: string, apiKey: string, model: string, temperature = 0): ChatFn {
  const client = new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "x" });
  return async (req) => {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
        { role: "user" as const, content: req.prompt },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? temperature,
      // Optional dialect-specific sampling (tongyi-dr native: stop / top_p / presence_penalty).
      ...(req.stop ? { stop: req.stop } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.presencePenalty !== undefined ? { presence_penalty: req.presencePenalty } : {}),
    });
    const choice = resp.choices[0];
    return {
      text: choice?.message?.content ?? "",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
      model: resp.model || model,
    };
  };
}

/**
 * Wrap a ChatFn with per-role sampling: inject a temperature (only when the caller did not set one)
 * and floor `maxTokens` so reasoning models get room for their `reasoning_content`. Returns the
 * original fn unchanged when there is nothing to apply (temp 0 + no floor) — zero overhead on the
 * non-thinking default roster. This is the productized form of the benchmark's `withAOverrides`.
 */
export function applyChatParams(fn: ChatFn, opts: { temperature?: number; minTokens?: number }): ChatFn {
  const temp = opts.temperature ?? 0;
  const floor = opts.minTokens ?? 0;
  if (temp <= 0 && floor <= 0) return fn;
  return (req) =>
    fn({
      ...req,
      ...(temp > 0 ? { temperature: req.temperature ?? temp } : {}),
      ...(floor > 0 ? { maxTokens: Math.max(req.maxTokens ?? 0, floor) } : {}),
    });
}

/** Build the full injected deps from config + request. Hybrid routes ONLY plan+synth to the API;
 *  distill ALWAYS stays local so raw page text never leaves the box (design §5 privacy line).
 *  In `agent` mode the `planner` port is the single driving brain (`config.agentModel`, local-only)
 *  and gets the agent temperature + a sensible reasoning-token floor. */
export function buildResearchDeps(
  config: DeepResearchConfig,
  req: { brain?: BrainMode; sensitive?: boolean; mode?: ResearchMode },
  opts: { log?: (m: string) => void; recordLedger?: ResearchDeps["recordLedger"] } = {}
): ResearchDeps {
  const wantHybrid =
    !req.sensitive && (req.brain === "hybrid" || (req.brain === undefined && config.brain === "hybrid"));
  const local = (model: string): ChatFn => makeChatFn(config.gatewayUrl, config.gatewayApiKey, model);
  const hybrid = (model: string): ChatFn => makeChatFn(config.hybridBaseUrl, config.hybridApiKey, model);

  if (req.mode === "agent") {
    // Single-brain ReAct mode: the agent model drives the loop (always local — raw pages never
    // leave the box). distiller/synthesizer are unused by the loop but the type requires them.
    const agent = applyChatParams(local(config.agentModel), {
      temperature: config.agentTemp,
      minTokens: Math.max(config.plannerMinTokens, 2000),
    });
    return {
      search: makeSearchProvider(config),
      read: makeReader(config),
      chat: { planner: agent, distiller: agent, synthesizer: agent },
      config,
      log: opts.log,
      recordLedger: opts.recordLedger,
    };
  }

  return {
    search: makeSearchProvider(config),
    read: makeReader(config),
    chat: {
      planner: applyChatParams(wantHybrid ? hybrid(config.hybridPlanModel) : local(config.plannerModel), {
        temperature: config.plannerTemp,
        minTokens: config.plannerMinTokens,
      }),
      distiller: applyChatParams(local(config.distillModel), {
        temperature: config.distillTemp,
        minTokens: config.distillMinTokens,
      }),
      synthesizer: applyChatParams(wantHybrid ? hybrid(config.hybridSynthModel) : local(config.synthModel), {
        temperature: config.synthTemp,
        minTokens: config.synthMinTokens,
      }),
    },
    config,
    log: opts.log,
    recordLedger: opts.recordLedger,
  };
}

// ─── Slug + output ───────────────────────────────────────────────────────────────

export function slugify(query: string, nowIso: string): string {
  const base = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = createHash("sha1").update(`${query}|${nowIso}`).digest("hex").slice(0, 6);
  return `${base || "research"}-${suffix}`;
}

export interface RunCliOptions {
  query: string;
  depth?: ResearchDepth;
  brain?: BrainMode;
  sensitive?: boolean;
  /** `deterministic` (default → runResearch) or `agent` (model-driven ReAct → runAgentResearch). */
  mode?: ResearchMode;
  /** Override the agent action-protocol dialect (default comes from config: tongyi). agent-mode only. */
  dialect?: AgentDialect;
  nowIso: string;
  /** Override the config output dir (tests point this at a tmp dir). */
  outputDir?: string;
  /** Disable ledger recording (default: record — dogfooding wants the signal). */
  noLedger?: boolean;
}

export interface RunCliResult {
  slug: string;
  dir: string;
  reportPath: string;
  popularPath: string;
  metaPath: string;
  stats: ResearchResult["stats"];
}

/** Injection seam for tests: provide a fake `deps` and/or a fake `run` to avoid network. */
export interface RunCliInjection {
  deps?: ResearchDeps;
  run?: typeof runResearch;
}

export async function runCli(opts: RunCliOptions, inj: RunCliInjection = {}): Promise<RunCliResult> {
  // A `--dialect` override mutates the agent action protocol the loop speaks (default: config = tongyi).
  const config = opts.dialect ? setDeepResearchConfig({ agentDialect: opts.dialect }) : loadDeepResearchConfig();
  const outputDir = opts.outputDir ?? config.outputDir;
  const request: ResearchRequest = {
    query: opts.query,
    nowIso: opts.nowIso,
    ...(opts.depth ? { depth: opts.depth } : {}),
    ...(opts.brain ? { brain: opts.brain } : {}),
    ...(opts.sensitive ? { sensitive: opts.sensitive } : {}),
  };

  const mode: ResearchMode = opts.mode ?? "deterministic";
  const deps =
    inj.deps ??
    buildResearchDeps(
      config,
      { ...request, mode },
      {
        log: (m) => process.stderr.write(`[deep-research] ${m}\n`),
        recordLedger: opts.noLedger ? undefined : (rec) => recordDelegation(rec),
      }
    );

  // Both pipelines share the same DI contract; agent mode flips the arg order (deps, req).
  const result: ResearchResult = inj.run
    ? await inj.run(request, deps)
    : mode === "agent"
      ? await runAgentResearch(deps, request)
      : await runResearch(request, deps);

  const slug = slugify(opts.query, opts.nowIso);
  const dir = join(outputDir, slug);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "report.md");
  const popularPath = join(dir, "popular.md");
  const metaPath = join(dir, "meta.json");
  writeFileSync(reportPath, result.report.markdown, "utf-8");
  writeFileSync(popularPath, `# ${result.popular.title}\n\n${result.popular.markdown}\n`, "utf-8");
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        query: opts.query,
        generatedAtIso: opts.nowIso,
        brain: result.report.brain,
        iterations: result.report.iterations,
        sources: result.report.sources.map((s) => ({ id: s.id, url: s.url, tier: s.tier })),
        stats: result.stats,
      },
      null,
      2
    ),
    "utf-8"
  );

  return { slug, dir, reportPath, popularPath, metaPath, stats: result.stats };
}

// ─── argv ────────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));

  if (cmd !== "run") {
    console.log(
      'Usage: tsx src/homeserver/deep-research-cli.ts run --query "..." \\\n' +
        "         [--mode deterministic|agent] [--dialect generic|tongyi] [--depth quick|thorough] \\\n" +
        "         [--brain local|hybrid] [--sensitive] [--out DIR] [--no-ledger]"
    );
    return;
  }

  const query = typeof flags["query"] === "string" ? (flags["query"] as string) : positional.join(" ");
  if (!query) throw new Error('deep-research run: --query "..." is required');
  const depth = flags["depth"] === "quick" ? "quick" : flags["depth"] === "thorough" ? "thorough" : undefined;
  const brain = flags["brain"] === "hybrid" ? "hybrid" : flags["brain"] === "local" ? "local" : undefined;
  const mode: ResearchMode = flags["mode"] === "agent" ? "agent" : "deterministic";
  const dialect: AgentDialect | undefined =
    flags["dialect"] === "tongyi" ? "tongyi" : flags["dialect"] === "generic" ? "generic" : undefined;

  const res = await runCli({
    query,
    nowIso: new Date().toISOString(),
    mode,
    ...(dialect ? { dialect } : {}),
    ...(depth ? { depth } : {}),
    ...(brain ? { brain } : {}),
    ...(flags["sensitive"] ? { sensitive: true } : {}),
    ...(typeof flags["out"] === "string" ? { outputDir: flags["out"] as string } : {}),
    ...(flags["no-ledger"] ? { noLedger: true } : {}),
  });

  console.log(
    JSON.stringify(
      {
        slug: res.slug,
        reportPath: res.reportPath,
        popularPath: res.popularPath,
        stats: res.stats,
      },
      null,
      2
    )
  );
}

// Run only when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1]?.endsWith("deep-research-cli.ts") ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
