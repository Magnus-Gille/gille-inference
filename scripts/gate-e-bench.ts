#!/usr/bin/env tsx
/**
 * gate-e-bench.ts — four-arm execution harness for the Gate E local-as-orchestrator bake-off.
 *
 * Produces one OrchTrace per task per arm. The BRAIN is a ChatFn; leaf execution is held
 * constant and LOCAL via delegate(). All arms share the same unified plan→execute→integrate
 * loop (runOrchestration); only the brain (and optional advisor) changes.
 *
 * ARMS
 *   a0  frontier brain (claude-opus-4-5 on OpenRouter) — the reference
 *   a1  local brain (qwen3-coder-next-80b on M5) — deterministic
 *   a2  local brain (agentic) — D1: runAgentResearch; D2–D4: generic loop w/ local brain
 *   a3  local brain + frontier advisor (capped at --advisor-k calls/task)
 *
 * CLI
 *   tsx scripts/gate-e-bench.ts --arm a1 [--brain <id>] [--advisor-k 3]
 *                               [--tasks D1-01,D3-02] [--save data/gate-e/] [--dry-run]
 *
 * Injection seam: runOrchestration accepts a `brain: ChatFn` and a `leafExecutor: LeafExecutorFn`.
 * The dry-run path injects synthetic stubs that produce passing traces deterministically.
 * The smoke test uses the same seam — no network calls in tests.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  makeChatFn,
} from "../src/homeserver/deep-research-cli.js";
import {
  resetDeepResearchConfig,
  setDeepResearchConfig,
} from "../src/homeserver/deep-research-config.js";
import { runAgentResearch } from "../src/homeserver/deep-research-agent.js";
import { delegate } from "../src/homeserver/orchestrator.js";
import { scoreArm } from "./gate-e-score.js";
import { ORCH_TASKS, getTask } from "./gate-e-tasks.js";
import type {
  OrchTask,
  OrchTrace,
  LeafCall,
  AdvisorCall,
  ArmId,
} from "./gate-e-types.js";
import type { ChatFn, ResearchDeps, Source } from "../src/homeserver/deep-research-types.js";

// ─── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ─── Env / config ─────────────────────────────────────────────────────────────

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const FRONTIER_MODEL = process.env["FRONTIER_MODEL"] ?? "anthropic/claude-opus-4-5";
const M5_BASE = (process.env["RESEARCH_GATEWAY_URL"] ?? "http://127.0.0.1:18091/v1").replace(/\/$/, "");
const DEFAULT_BRAIN = "qwen3-coder-next-80b";
// D1 distiller is held CONSTANT and LOCAL across all arms (the proven rich-mellum
// pre-digest) — only the plan/synth BRAIN changes per arm. See gate-de-evaluation-plan §"arms".
const DISTILL_MODEL = process.env["GATE_E_DISTILL_MODEL"] ?? "mellum";
const DEFAULT_ADVISOR_K = 3;
const PLAN_MAX_TOKENS = 2048;
const INTEGRATE_MAX_TOKENS = 2048;
const LEAF_MAX_TOKENS = 1024;

// ─── LeafExecutor type ────────────────────────────────────────────────────────

/**
 * Leaf executor injection seam. Receives the brain's decomposed sub-task and returns a
 * populated LeafCall. Real arms call delegate(); dry-run injects a synthetic stub.
 */
export type LeafExecutorFn = (
  subtask: string,
  taskType: string,
  input: string,
  escalateHint: boolean,
  escalationModel: string,
  maxTokens: number,
) => Promise<LeafCall>;

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * D1 corpus-read tracking — populated by the corpus leaf executor, read for sourcesRead.
 * Carries the already-loaded `sources` so the integrate stage NEVER re-reads the corpus
 * from disk (the FRAMES corpus is gitignored → absent in CI; the grounded path must not
 * depend on disk a second time).
 */
export interface CorpusReadState {
  readIds: Set<string>;
  corpusSize: number;
  sources: Source[];
}

export interface OrchOptions {
  arm: ArmId;
  brainModel: string;
  escalationModel: string;
  advisorK: number;
  advisorFn?: ChatFn; // A3 only
  /** D1 only: the corpus-read state the (grounded) leaf executor writes to. */
  corpusState?: CorpusReadState;
}

interface RealLeafExecutorOptions {
  /** Cloud brain that delegated local leaves. Leave unset for local-brain arms to avoid false savings. */
  delegatorModelId?: string;
}

// ─── Plan parsing ─────────────────────────────────────────────────────────────

interface PlanStep {
  label: string;
  taskType: string;
  input: string;
  escalate?: boolean;
  action?: string;
  question?: string;
}

/**
 * Robustly parse the brain's plan response into PlanStep[].
 * Strips ```json fences, tolerates prose around the JSON array, handles {action:"ASK_ADVISOR"}.
 * Returns null on complete parse failure (triggers runtimeError in the trace).
 */
/**
 * Coerce a plan step's `escalate` field to a boolean WITHOUT the JS string-truthiness
 * trap: `Boolean("false")` is `true`. LLMs frequently emit string booleans, so a naive
 * cast would silently turn every `"escalate":"false"` into an escalation — manufacturing
 * over-escalation, advisor calls, and distorted E4/E6. Only real `true` or the string
 * "true"/"yes"/"1" (case-insensitive) count as escalation.
 */
export function coerceEscalate(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  return false;
}

/**
 * Extract the first balanced top-level JSON array substring, tracking string literals so
 * that brackets OR markdown code fences inside string values don't terminate it early. This
 * replaces a fence/greedy-regex approach that a frontier brain broke by emitting a ```json
 * plan whose `input` value itself contained a ```ts fence (Opus D2-03): the non-greedy fence
 * regex matched the inner ``` and truncated the array. Returns null if there is no balanced
 * array. Exported for unit testing.
 */
/** The balanced array span starting at `start` (text[start] must be '['), or null if it
 *  never closes. Tracks string literals so brackets/fences inside strings don't count. */
function balancedArrayFrom(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJsonArray(text: string): string | null {
  // Try EVERY '[' position, not just the first: leading prose can contain a bracketed aside
  // (e.g. "Here is [a draft] then …") before the real array. Return the first balanced span
  // that JSON-parses to a NON-EMPTY array — i.e. the actual plan, not a prose bracket or [].
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    const span = balancedArrayFrom(text, start);
    if (span === null) continue;
    try {
      const parsed = JSON.parse(span);
      if (Array.isArray(parsed) && parsed.length > 0) return span;
    } catch {
      /* not valid JSON at this '[' — try the next one */
    }
  }
  return null;
}

export function parsePlan(text: string): PlanStep[] | null {
  // Strip <think>…</think> blocks (for thinking models)
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Find the first balanced JSON array, robust to surrounding ```json fences, leading prose,
  // and fences/brackets that appear INSIDE string values.
  const arr = extractJsonArray(stripped);
  if (!arr) return null;

  try {
    const parsed = JSON.parse(arr);
    if (!Array.isArray(parsed)) return null;
    // Validate and coerce each step
    const steps: PlanStep[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const label = String(item.label ?? item.subtask ?? item.name ?? "step");
      const taskType = String(item.taskType ?? item.task_type ?? item.type ?? "qa-factual");
      const input = String(item.input ?? item.prompt ?? item.content ?? "");
      const escalate = coerceEscalate(item.escalate);
      const action = item.action ? String(item.action) : undefined;
      const question = item.question ? String(item.question) : undefined;
      steps.push({ label, taskType, input, escalate, action, question });
    }
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

// ─── Corpus loader for D1 ─────────────────────────────────────────────────────

interface CorpusSource {
  id: string;
  url: string;
  title: string;
  tier: "primary" | "secondary" | "tertiary";
  markdown: string;
}

interface CorpusFile {
  query: string;
  sources: CorpusSource[];
}

function loadCorpus(corpusRef: string): CorpusFile {
  const fullPath = join(REPO_ROOT, corpusRef);
  if (!existsSync(fullPath)) {
    throw new Error(`Corpus not found: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf-8")) as CorpusFile;
}

function corpusSourcesToSources(cs: CorpusSource[]): Source[] {
  return cs.map((s, i) => ({
    id: `S${i + 1}`,
    url: s.url,
    title: s.title,
    tier: s.tier,
    markdown: s.markdown,
    contentHash: String(i),
  }));
}

// ─── D1 corpus-grounded leaf executor (the FRAMES oracle) ─────────────────────

function corpusTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

/**
 * Query-aware window retrieval over a FULL source. FRAMES sources run to ~24k chars and the
 * gold fact can sit past char 22k (e.g. D1-05's "506,132") — a fixed prefix slice would
 * "read" a source without ever showing the brain the fact it must ground, defeating the
 * oracle (Codex re-review #B). We instead pick the overlapping window with the most overlap
 * against the sub-query, so the gold fact's neighbourhood is what gets distilled.
 */
export function bestWindow(
  markdown: string,
  query: Set<string>,
  windowChars = 7000,
  stride = 4000,
): string {
  if (markdown.length <= windowChars) return markdown;
  let best = markdown.slice(0, windowChars);
  let bestScore = -1;
  for (let start = 0; start < markdown.length; start += stride) {
    const w = markdown.slice(start, start + windowChars);
    const toks = new Set(corpusTokens(w));
    let score = 0;
    for (const q of query) if (toks.has(q)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
    if (start + windowChars >= markdown.length) break;
  }
  return best;
}

/**
 * D1 leaves MUST read the frozen FRAMES corpus (the oracle) — otherwise D1 degenerates
 * into parametric QA with post-hoc citation metadata (Codex #1). Each leaf retrieves the
 * best-matching UNREAD frozen source for its sub-query and distils it with the LOCAL
 * mellum distiller (held constant across arms — the rich-mellum pre-digest), tagging the
 * output with the source's [S#] id so the synth brain can cite it. `state.readIds` records
 * the concrete reads (drives the real sourcesRead / under-read collapse signal — no fake
 * leaf-count fallback).
 */
export function makeCorpusLeafExecutor(
  corpus: CorpusFile,
  distillChat: ChatFn,
  state: CorpusReadState,
): LeafExecutorFn {
  // Stable [S#] ids by position, matching corpusSourcesToSources().
  const tagged = corpus.sources.map((s, i) => ({ src: s, sid: `S${i + 1}` }));
  return async (subtask, taskType, input, _escalateHint, _escalationModel, maxTokens) => {
    const q = new Set(corpusTokens(`${subtask} ${input}`));
    const ranked = [...tagged]
      .map((t) => {
        // Rank over the FULL source (title + body), not a prefix — the discriminating
        // tokens for a sub-query can live deep in a long FRAMES page.
        const body = new Set(corpusTokens(`${t.src.title} ${t.src.markdown}`));
        let score = 0;
        for (const w of q) if (body.has(w)) score++;
        return { ...t, score, read: state.readIds.has(t.sid) };
      })
      // Prefer an unread source, then the highest token overlap.
      .sort((a, b) => Number(a.read) - Number(b.read) || b.score - a.score);
    const pick = ranked[0] ?? tagged[0];
    state.readIds.add(pick.sid);
    const resp = await distillChat({
      system:
        "Summarize the SOURCE faithfully so it answers the SUB-QUERY. Use only facts present in the source; do not invent.",
      prompt: `SUB-QUERY: ${input}\n\nSOURCE [${pick.sid}] ${pick.src.title}:\n${bestWindow(pick.src.markdown, q)}`,
      maxTokens,
    });
    return {
      subtask,
      taskType: taskType || "summarize",
      modelId: resp.model || DISTILL_MODEL,
      escalated: false,
      output: `[${pick.sid}] ${pick.src.title}: ${resp.text}`,
      promptTokens: resp.promptTokens,
      completionTokens: resp.completionTokens,
    };
  };
}

// ─── Real leaf executor (wraps delegate()) ────────────────────────────────────

/**
 * The shared LOCAL leaf substrate. The bench OWNS and METERS every frontier call so the
 * E6 frontier-token-share gate is exact — we never read tokens off `delegate()`'s opaque
 * internal frontier fallback (its OpenRouter usage isn't separately exposed; the
 * `metrics` field is the LOCAL attempt only — counting it as frontier, or missing the real
 * frontier usage, would corrupt E6). So `delegate()` is called WITHOUT a `frontierModelId`:
 * we use only its `escalate` SIGNAL and then run the frontier ourselves via `frontierChat`.
 *
 * Escalation is observed two ways (both feed E4):
 *  1. Brain JUDGMENT — the plan marks a step `escalate:true` → frontier directly.
 *  2. Substrate POLICY — `delegate().escalate` (m5-routing.json sql→frontier with
 *     HOMESERVER_USE_ROUTING_TABLE=on, or verifier-fail) → frontier.
 *
 * `escalated` reflects whether the frontier was ACTUALLY used: if escalation is wanted but
 * no `frontierChat` is supplied (e.g. A3's substrate-only executor — its only frontier path
 * is the capped advisor), the leaf runs local and `escalated:false`, keeping the metric and
 * the E6 measure honest.
 */
export function makeRealLeafExecutor(frontierChat?: ChatFn, opts: RealLeafExecutorOptions = {}): LeafExecutorFn {
  const runFrontier = async (
    subtask: string,
    taskType: string,
    input: string,
    escalationModel: string,
    maxTokens: number,
  ): Promise<LeafCall> => {
    const resp = await frontierChat!({ prompt: input, maxTokens });
    return {
      subtask,
      taskType,
      modelId: escalationModel || "FRONTIER",
      escalated: true,
      output: resp.text,
      promptTokens: resp.promptTokens, // REAL, metered frontier usage
      completionTokens: resp.completionTokens,
    };
  };

  return async (subtask, taskType, input, escalateHint, escalationModel, maxTokens) => {
    // Path 1: the brain explicitly escalated → frontier directly (skip the local attempt).
    if (escalateHint && frontierChat) {
      return runFrontier(subtask, taskType, input, escalationModel, maxTokens);
    }
    // Local attempt — NO frontierModelId, so delegate() never makes an opaque frontier call.
    const outcome = await delegate({
      prompt: input,
      taskType,
      maxTokens,
      delegatorModelId: opts.delegatorModelId,
      keyAlias: "local:gate-e-bench",
    });
    // Path 2: substrate policy says escalate AND we have a metered frontier channel.
    if (outcome.escalate && frontierChat) {
      return runFrontier(subtask, taskType, input, escalationModel, maxTokens);
    }
    // Local result (or escalation wanted but no frontier channel → ran local, not escalated).
    return {
      subtask,
      taskType,
      modelId: outcome.modelId,
      escalated: false,
      output: outcome.output ?? "",
      promptTokens: outcome.metrics?.promptTokens ?? 0,
      completionTokens: outcome.metrics?.completionTokens ?? 0,
    };
  };
}

// ─── Unified orchestration loop ───────────────────────────────────────────────

/**
 * Run one task through the plan→execute→integrate loop.
 * brain and leafExecutor are injected (the real seam for dry-run / smoke tests).
 */
export async function runOrchestration(
  task: OrchTask,
  brain: ChatFn,
  leafExecutor: LeafExecutorFn,
  opts: OrchOptions,
): Promise<OrchTrace> {
  const startMs = Date.now();
  let brainPromptTokens = 0;
  let brainCompletionTokens = 0;
  const leafCalls: LeafCall[] = [];
  const advisorCalls: AdvisorCall[] = [];
  let runtimeError: string | undefined;

  const maxLeafTokens = task.maxLeafTokens ?? LEAF_MAX_TOKENS;

  // ── Step 1: PLAN ────────────────────────────────────────────────────────────
  const planPrompt =
    `Decompose the following goal into a JSON array of sub-tasks. ` +
    `Return ONLY a JSON array (no prose before or after). ` +
    `Each element must be: {"label":"...", "taskType":"...", "input":"...", "escalate": false}. ` +
    `taskType must be one of: sql, extract, summarize, classify, code-implement, rewrite, ` +
    `reason-math, qa-factual, data-transform, code-review, translate, sentiment-classify, ` +
    `json-schema, format-convert. ` +
    `For tasks you cannot handle locally, set "escalate":true. ` +
    `Goal: ${task.prompt}`;

  let planSteps: PlanStep[] = [];
  try {
    const planResp = await brain({ prompt: planPrompt, maxTokens: PLAN_MAX_TOKENS });
    brainPromptTokens += planResp.promptTokens;
    brainCompletionTokens += planResp.completionTokens;
    const parsed = parsePlan(planResp.text);
    if (!parsed) {
      runtimeError = `plan-parse-failure: could not parse JSON plan from brain output`;
    } else {
      planSteps = parsed;
    }
  } catch (err) {
    runtimeError = `plan-error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // ── Step 2: EXECUTE each sub-task as a LeafCall ─────────────────────────────
  let advisorUsed = 0;
  const leafOutputs: string[] = [];

  // A thrown leaf (missing key, transient API error, …) must NOT abort the whole arm
  // run — record runtimeError so classifyCollapse() scores it as an `error` collapse
  // (E2), and return signalling the caller to stop executing further leaves.
  const runLeaf = async (step: PlanStep): Promise<boolean> => {
    try {
      const lc = await leafExecutor(
        step.label,
        step.taskType,
        step.input,
        step.escalate,
        opts.escalationModel,
        maxLeafTokens,
      );
      leafCalls.push(lc);
      leafOutputs.push(lc.output);
      return true;
    } catch (err) {
      runtimeError = runtimeError ?? `leaf-error: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  };

  for (const step of planSteps) {
    // A3: intercept ASK_ADVISOR action or escalate:true hints → frontier advisor.
    // EXCEPT for D1 corpus-grounded tasks (opts.corpusState present): there every leaf
    // MUST read the frozen FRAMES corpus, so letting the advisor answer a step from raw
    // parametric knowledge would silently un-ground D1 (Codex re-review #A). D1 has no
    // gap leaves anyway — its job is reading+synthesis, not escalation judgment.
    if (
      opts.arm === "a3" &&
      opts.advisorFn &&
      !opts.corpusState &&
      advisorUsed < opts.advisorK &&
      (step.action === "ASK_ADVISOR" || step.escalate === true)
    ) {
      const question = step.question ?? step.input;
      try {
        const resp = await opts.advisorFn({
          prompt: question,
          maxTokens: maxLeafTokens,
        });
        advisorCalls.push({
          question,
          promptTokens: resp.promptTokens,
          completionTokens: resp.completionTokens,
          model: opts.escalationModel,
        });
        advisorUsed++;
        // Treat the advisor answer as the leaf output. Record a leafCall so E4's
        // escalation metrics see it (escalated, matchable taskType) — but with ZERO
        // tokens: the tokens live in the AdvisorCall above, and frontierTokens()/
        // totalTokens() sum BOTH advisorCalls and escalated leafCalls, so counting the
        // tokens here too would double-count the advisor spend in the E6 share.
        leafOutputs.push(resp.text);
        leafCalls.push({
          subtask: step.label,
          taskType: step.taskType,
          modelId: opts.escalationModel,
          escalated: true,
          output: resp.text,
          promptTokens: 0,
          completionTokens: 0,
        });
      } catch (err) {
        // advisor call failed; fall through to the (wrapped) leaf executor
        runtimeError = runtimeError ?? `advisor-error: ${err instanceof Error ? err.message : String(err)}`;
        if (!(await runLeaf(step))) break;
      }
    } else {
      // Normal leaf execution (wrapped so a throw → error collapse, not an aborted run)
      if (!(await runLeaf(step))) break;
    }
  }

  // ── Step 3 (D2): extract producedCode from the plan steps ───────────────────
  // For D2, the brain's plan likely includes a "code-implement" leaf whose output
  // is the TypeScript code block. We collect it as producedCode.
  let producedCode: string | undefined;
  if (task.family === "D2") {
    // Find the first code-implement leaf output (or any ```ts block in any leaf)
    for (const lc of leafCalls) {
      const match = /```(?:ts|typescript)([\s\S]*?)```/.exec(lc.output);
      if (match) {
        producedCode = `\`\`\`ts${match[1]}\`\`\``;
        break;
      }
    }
    // If no leaf had a code block, the INTEGRATE step (brain) will produce it
  }

  // ── Step 4: INTEGRATE (brain synthesizes leaf outputs into the final answer) ─
  let finalAnswer = "";
  let reportMarkdown: string | undefined;
  let reportSources: Source[] | undefined;
  let sourcesRead: number | undefined;
  let corpusSize: number | undefined;

  if (planSteps.length === 0 && runtimeError) {
    // Short-circuit: plan failed, can't integrate
    finalAnswer = "";
  } else {
    const leafSummary = leafCalls
      .map((lc, i) => `[Subtask ${i + 1}: ${lc.subtask}]\n${lc.output}`)
      .join("\n\n");

    const integratePrompt =
      task.family === "D2"
        ? `You planned and executed the following sub-tasks. Based on the results below, produce ` +
          `the final TypeScript implementation as a single \`\`\`ts code block. ` +
          `Include the implementation only — no explanation.\n\nSub-task results:\n${leafSummary}\n\n` +
          `Return only the TypeScript code in a single \`\`\`ts block.`
        : task.family === "D1"
          ? `Based on the research sub-task results below, write a comprehensive research report ` +
            `with [S#] citation markers where appropriate. Then provide a concise final answer.\n\n` +
            `Sub-task results:\n${leafSummary}\n\nReport (with citations) then Final Answer:`
          : `Based on the sub-task results below, synthesize the final answer to the original goal.\n\n` +
            `Goal: ${task.prompt}\n\nSub-task results:\n${leafSummary}\n\nFinal Answer:`;

    try {
      const intResp = await brain({ prompt: integratePrompt, maxTokens: INTEGRATE_MAX_TOKENS });
      brainPromptTokens += intResp.promptTokens;
      brainCompletionTokens += intResp.completionTokens;
      const intText = intResp.text ?? "";

      if (task.family === "D1") {
        // Split report vs final answer: the brain produces report + answer
        // Look for "Final Answer:" marker; everything before is the report
        const splitMatch = /final\s+answer\s*[:：]?\s*/i.exec(intText);
        if (splitMatch && splitMatch.index !== undefined) {
          reportMarkdown = intText.slice(0, splitMatch.index).trim();
          finalAnswer = intText.slice(splitMatch.index + splitMatch[0].length).trim();
        } else {
          reportMarkdown = intText;
          finalAnswer = intText.slice(0, 500).trim(); // fallback: first 500 chars as answer
        }
        // reportSources + the real read-count. The GROUNDED path (corpusState) uses the
        // already-loaded sources — NO disk re-read (the FRAMES corpus is gitignored, so a
        // disk load here would throw in CI). sourcesRead reflects ONLY concrete corpus
        // reads (Codex #1 — no leaf-count fallback that would fake the under-read signal).
        if (opts.corpusState) {
          reportSources = opts.corpusState.sources;
          corpusSize = opts.corpusState.corpusSize;
          sourcesRead = opts.corpusState.readIds.size;
        } else if (task.corpusRef) {
          // Ungrounded fallback (e.g. dry-run): load from disk defensively — a missing
          // corpus must not blank the whole integrate result.
          try {
            const corpus = loadCorpus(task.corpusRef);
            reportSources = corpusSourcesToSources(corpus.sources);
            corpusSize = corpus.sources.length;
            sourcesRead = reportSources.filter((s) =>
              leafOutputs.some((o) => o.includes(s.title) || o.includes(s.url)),
            ).length;
          } catch {
            /* corpus unavailable (e.g. CI without the gitignored data dir) — leave unset */
          }
        }
      } else if (task.family === "D2") {
        finalAnswer = intText;
        // Extract producedCode from the integrate output if not already found
        if (!producedCode) {
          const match = /```(?:ts|typescript)([\s\S]*?)```/.exec(intText);
          if (match) {
            producedCode = `\`\`\`ts${match[1]}\`\`\``;
          }
        }
      } else {
        finalAnswer = intText;
      }
    } catch (err) {
      runtimeError = runtimeError ?? `integrate-error: ${err instanceof Error ? err.message : String(err)}`;
      finalAnswer = "";
    }
  }

  const wallMs = Date.now() - startMs;

  return {
    taskId: task.id,
    arm: opts.arm,
    brainModel: opts.brainModel,
    plan: planSteps.map((s) => s.label),
    leafCalls,
    advisorCalls,
    finalAnswer,
    reportMarkdown,
    reportSources,
    producedCode,
    wallMs,
    brainPromptTokens,
    brainCompletionTokens,
    runtimeError,
    sourcesRead,
    corpusSize,
  };
}

// ─── A2 D1: agentic path using runAgentResearch ───────────────────────────────
// For D1 tasks in A2, we use the full runAgentResearch loop with the local brain
// and the frozen FRAMES corpus stub. For D2–D4 in A2, we reuse the generic loop
// with the local brain (A2 for non-D1 tasks = same as A1 but "agentic" labelled).

async function runA2D1Task(
  task: OrchTask,
  brain: ChatFn,
  opts: OrchOptions,
): Promise<OrchTrace> {
  const startMs = Date.now();

  if (!task.corpusRef) {
    return {
      taskId: task.id,
      arm: opts.arm,
      brainModel: opts.brainModel,
      plan: [],
      leafCalls: [],
      advisorCalls: [],
      finalAnswer: "",
      wallMs: Date.now() - startMs,
      brainPromptTokens: 0,
      brainCompletionTokens: 0,
      runtimeError: "D1 task missing corpusRef",
    };
  }

  const corpus = loadCorpus(task.corpusRef);
  const sources = corpusSourcesToSources(corpus.sources);

  // Build stub search/reader from the frozen corpus (same pattern as frames-eval.ts)
  const stubSearch = {
    name: "frozen-frames-corpus",
    async search(_q: string) {
      return sources.map((s) => ({ url: s.url, title: s.title, snippet: s.markdown.slice(0, 250) }));
    },
  };
  const byUrl = new Map(sources.map((s) => [s.url, s]));
  const stubReader = {
    name: "frozen-frames-corpus",
    async read(url: string) {
      const src = byUrl.get(url);
      if (!src) return { url, title: url, markdown: "", isThin: true, fetchedVia: "frozen-frames-corpus" };
      return { url, title: src.title, markdown: src.markdown, isThin: false, fetchedVia: "frozen-frames-corpus" };
    },
  };

  resetDeepResearchConfig();
  const config = setDeepResearchConfig({
    plannerModel: opts.brainModel,
    distillModel: opts.brainModel,
    synthModel: opts.brainModel,
    brain: "local",
    gatewayUrl: M5_BASE,
    gatewayApiKey: "x",
    maxIters: 1,
    maxSourcesPerIter: sources.length + 2,
  });

  const deps: ResearchDeps = {
    search: stubSearch,
    read: stubReader,
    chat: { planner: brain, distiller: brain, synthesizer: brain },
    config,
    log: () => {},
  };

  try {
    const result = await runAgentResearch(deps, {
      query: task.prompt,
      depth: "quick",
      brain: "local",
      nowIso: new Date().toISOString(),
    });

    const report = result.report;
    const sourcesRead = report.sources.length;

    return {
      taskId: task.id,
      arm: opts.arm,
      brainModel: opts.brainModel,
      plan: report.sections.map((s) => s.heading),
      leafCalls: [], // agent mode has no discrete leaf calls in OrchTrace form
      advisorCalls: [],
      finalAnswer: report.markdown.slice(0, 500), // first 500 chars as "answer"
      reportMarkdown: report.markdown,
      reportSources: report.sources,
      wallMs: Date.now() - startMs,
      brainPromptTokens: result.stats.totalCompletionTokens, // best approximation
      brainCompletionTokens: 0,
      sourcesRead,
      corpusSize: sources.length,
    };
  } catch (err) {
    return {
      taskId: task.id,
      arm: opts.arm,
      brainModel: opts.brainModel,
      plan: [],
      leafCalls: [],
      advisorCalls: [],
      finalAnswer: "",
      wallMs: Date.now() - startMs,
      brainPromptTokens: 0,
      brainCompletionTokens: 0,
      runtimeError: `agent-error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Save helpers ─────────────────────────────────────────────────────────────

function saveTrace(saveDir: string, arm: ArmId, trace: OrchTrace): void {
  const armDir = join(saveDir, arm);
  mkdirSync(armDir, { recursive: true });
  writeFileSync(
    join(armDir, `${trace.taskId}.trace.json`),
    JSON.stringify(trace, null, 2),
    "utf-8",
  );
  // D1: write report as q<N>-<arm>.md (N = 1-based index within D1)
  if (trace.taskId.startsWith("D1") && trace.reportMarkdown) {
    const match = /D1-0?(\d+)/.exec(trace.taskId);
    if (match) {
      const n = parseInt(match[1]!, 10);
      writeFileSync(
        join(saveDir, `q${n}-${arm}.md`),
        trace.reportMarkdown,
        "utf-8",
      );
    }
  }
}

function printTaskLine(trace: OrchTrace, answerPass: number, planCov: number, collapse: string | null): void {
  const passStr = answerPass === 1 ? "PASS" : "FAIL";
  const covStr = (planCov * 100).toFixed(0) + "%";
  const colStr = collapse ?? "-";
  process.stdout.write(
    `  ${trace.taskId.padEnd(8)} ${passStr}  cov=${covStr}  collapse=${colStr}  leaves=${trace.leafCalls.length}  wall=${trace.wallMs}ms\n`,
  );
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runArm(
  arm: ArmId,
  tasks: OrchTask[],
  brain: ChatFn,
  leafExecutor: LeafExecutorFn,
  opts: OrchOptions,
  saveDir: string | null,
  dryRun: boolean,
): Promise<OrchTrace[]> {
  const { scoreTask } = await import("./gate-e-score.js");
  const traces: OrchTrace[] = [];

  process.stdout.write(`\n[gate-e] arm=${arm} brain=${opts.brainModel} tasks=${tasks.length}\n`);

  for (const task of tasks) {
    let trace: OrchTrace;
    if (arm === "a2" && task.family === "D1" && !dryRun) {
      trace = await runA2D1Task(task, brain, opts);
    } else if (task.family === "D1" && task.corpusRef && !dryRun) {
      // D1 (a0/a1/a3): ground the leaves in the frozen FRAMES corpus via the local-mellum
      // distiller (the oracle) — NOT the generic delegate() substrate, which would let the
      // brain answer from parametric knowledge (Codex #1).
      const corpus = loadCorpus(task.corpusRef);
      const state: CorpusReadState = {
        readIds: new Set(),
        corpusSize: corpus.sources.length,
        sources: corpusSourcesToSources(corpus.sources),
      };
      const distillChat = makeChatFn(M5_BASE, "x", DISTILL_MODEL, 0);
      const corpusLeaf = makeCorpusLeafExecutor(corpus, distillChat, state);
      trace = await runOrchestration(task, brain, corpusLeaf, { ...opts, corpusState: state });
    } else {
      trace = await runOrchestration(task, brain, leafExecutor, opts);
    }

    const ts = await scoreTask(task, trace);
    if (saveDir) saveTrace(saveDir, arm, trace);
    printTaskLine(trace, ts.answerPass, ts.planCoverage, ts.collapse);
    traces.push(trace);
  }

  // Write scores.json
  if (saveDir && !dryRun) {
    const allTasks = tasks.map((t) => getTask(t.id)!);
    const scores = await scoreArm(allTasks, traces);
    const armDir = join(saveDir, arm);
    mkdirSync(armDir, { recursive: true });
    writeFileSync(join(armDir, "scores.json"), JSON.stringify(scores, null, 2), "utf-8");
  }

  return traces;
}

// ─── Dry-run synthetic stubs ─────────────────────────────────────────────────
//
// When --dry-run is active, the brain and leaf executor are replaced with
// deterministic stubs that produce a valid, scoring OrchTrace without any
// network calls. The synthetic brain reads the gold from task.scorer to
// produce a passing final answer; the synthetic leaf marks gap leaves as escalated.
//
// These stubs are also the injection points used by gate-e-bench.test.ts.

export function makeSyntheticBrain(task: OrchTask): ChatFn {
  let callCount = 0;
  return async (req) => {
    callCount++;
    if (callCount === 1) {
      // PLAN call: return a JSON plan covering requiredSubtasks
      const plan = task.requiredSubtasks.map((rs, i) => ({
        label: rs,
        taskType: task.gapLeaves.length > 0 && i === 0 ? task.gapLeaves[0]! : "qa-factual",
        input: rs,
        escalate: task.gapLeaves.length > 0 && i === 0,
      }));
      return {
        text: JSON.stringify(plan),
        promptTokens: 50,
        completionTokens: 100,
        model: "synthetic",
      };
    }
    // INTEGRATE call: return a final answer containing the gold token(s)
    let answer: string;
    if (task.scorer.kind === "frames" || task.scorer.kind === "answer-match") {
      answer = `The answer is: ${task.scorer.goldAnswer}`;
    } else if (task.scorer.kind === "pipeline") {
      answer = `The top 3 are: ${task.scorer.goldTop3.join(", ")}`;
    } else {
      // tsGate: return a minimal passing implementation
      // The harness verifier will run tsc; we emit a stub that exports the right name
      // but real tsGate only runs in real mode — in dry-run the leaf executor returns code
      answer = "// synthetic code — dry-run only";
    }
    // For D1, wrap in a simple "report + Final Answer" format
    if (task.family === "D1") {
      return {
        text: `Research report for: ${task.prompt}\n\nFinal Answer: ${answer}`,
        promptTokens: 50,
        completionTokens: 100,
        model: "synthetic",
      };
    }
    return {
      text: answer,
      promptTokens: 50,
      completionTokens: 100,
      model: "synthetic",
    };
  };
}

export function makeSyntheticLeafExecutor(task: OrchTask): LeafExecutorFn {
  return async (subtask, taskType, _input, _escalateHint, escalationModel, _maxTokens) => {
    const isGap = task.gapLeaves.some(
      (g) => taskType === g || subtask.toLowerCase().includes(g.toLowerCase()),
    );
    // For D2, the leaf should produce a real code block that the integrate step can use
    let output = `Result for: ${subtask}`;
    if (task.family === "D2" && taskType === "code-implement") {
      // We can't pass tsGate in dry-run (no real tsc); output a placeholder
      output = "```ts\n// synthetic implementation\n```";
    }
    return {
      subtask,
      taskType,
      modelId: isGap ? (escalationModel || "FRONTIER") : "synthetic-local",
      escalated: isGap,
      output,
      promptTokens: 20,
      completionTokens: 30,
    };
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  function flag(name: string): boolean {
    return argv.includes(name);
  }
  function opt(name: string, def = ""): string {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
  }

  const armId = (opt("--arm", "a1")) as ArmId;
  const brainOverride = opt("--brain", "");
  const advisorK = parseInt(opt("--advisor-k", String(DEFAULT_ADVISOR_K)), 10);
  const tasksFilter = opt("--tasks", "");
  const saveDir = opt("--save", "");
  const dryRun = flag("--dry-run");

  const brainModel = brainOverride || (armId === "a0" ? FRONTIER_MODEL : DEFAULT_BRAIN);
  const escalationModel = FRONTIER_MODEL;

  // Resolve task set
  let tasks: OrchTask[] = ORCH_TASKS;
  if (tasksFilter) {
    const ids = tasksFilter.split(",").map((s) => s.trim()).filter(Boolean);
    tasks = ids.map((id) => getTask(id)).filter((t): t is OrchTask => t != null);
    if (tasks.length === 0) {
      console.error(`[gate-e] No tasks matched filter: ${tasksFilter}`);
      process.exit(1);
    }
  }

  // Build brain ChatFn
  let brain: ChatFn;
  let leafExecutor: LeafExecutorFn;
  let advisorFn: ChatFn | undefined;

  if (dryRun) {
    // In dry-run, per-task synthetic brain is injected inside runOrchestration via a dispatch shim
    // We use a task-dispatch wrapper so the brain adapts per task (needed for gold reading).
    // The real callers in the test use makeSyntheticBrain(task) directly.
    // For the CLI dry-run, we run each task separately with its own synthetic brain.
    console.log(`[gate-e] DRY-RUN arm=${armId} tasks=${tasks.length}`);
    const { scoreTask } = await import("./gate-e-score.js");

    const traces: OrchTrace[] = [];
    for (const task of tasks) {
      const synBrain = makeSyntheticBrain(task);
      const synLeaf = makeSyntheticLeafExecutor(task);
      const synOpts: OrchOptions = {
        arm: armId,
        brainModel: "synthetic",
        escalationModel: "synthetic-frontier",
        advisorK: 0,
      };
      const trace = await runOrchestration(task, synBrain, synLeaf, synOpts);
      const ts = await scoreTask(task, trace);
      printTaskLine(trace, ts.answerPass, ts.planCoverage, ts.collapse);
      traces.push(trace);
      if (saveDir) saveTrace(saveDir, armId, trace);
    }

    console.log(`[gate-e] dry-run complete: ${traces.length} traces`);
    return;
  }

  // Frontier ChatFn for brain-HINTED leaf escalation (Path 1 in makeRealLeafExecutor).
  // NOT given to A3: there the capped advisor is the only frontier path — a hint-honoring
  // executor would bypass the K-cap and silently inflate the E6 frontier-token share.
  const frontierLeafChat = makeChatFn(OPENROUTER_BASE, OPENROUTER_API_KEY, escalationModel, 0);

  // Real arms
  switch (armId) {
    case "a0":
      brain = makeChatFn(OPENROUTER_BASE, OPENROUTER_API_KEY, brainModel, 0);
      leafExecutor = makeRealLeafExecutor(frontierLeafChat, { delegatorModelId: brainModel });
      break;
    case "a1":
      brain = makeChatFn(M5_BASE, "x", brainModel, 0);
      leafExecutor = makeRealLeafExecutor(frontierLeafChat);
      break;
    case "a2":
      brain = makeChatFn(M5_BASE, "x", brainModel, 0);
      leafExecutor = makeRealLeafExecutor(frontierLeafChat);
      break;
    case "a3":
      brain = makeChatFn(M5_BASE, "x", brainModel, 0);
      advisorFn = makeChatFn(OPENROUTER_BASE, OPENROUTER_API_KEY, escalationModel, 0);
      leafExecutor = makeRealLeafExecutor(); // substrate-only; advisor is the capped frontier path
      break;
    default:
      console.error(`[gate-e] Unknown arm: ${armId}`);
      process.exit(1);
  }

  const orchOpts: OrchOptions = {
    arm: armId,
    brainModel,
    escalationModel,
    advisorK,
    advisorFn,
  };

  const savePath = saveDir || null;
  if (savePath) mkdirSync(savePath, { recursive: true });

  await runArm(armId, tasks, brain, leafExecutor, orchOpts, savePath, dryRun);

  console.log(`\n[gate-e] done.`);
}

// Only run the CLI when invoked directly (tsx scripts/gate-e-bench.ts …) — NOT when this
// module is imported by the unit tests, which would otherwise fire a real arm run.
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
