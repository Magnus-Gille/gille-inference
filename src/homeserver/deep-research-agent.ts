/**
 * Deep-research harness — model-driven ReAct mode (issue #40).
 *
 * ALONGSIDE the deterministic `runResearch` pipeline (deep-research.ts), this runs a single
 * reasoning model (Tongyi-DeepResearch-30B-A3B) as the long-horizon driver: it chooses
 * search / read / reflect / answer over multiple turns, while the HARNESS keeps hard guardrails
 * in code (turn + token caps, parse-failure / stall force-finalize, SSRF-protected reads inherited
 * from the reader) and REUSES the deterministic `citation-verifier.ts` as the trust anchor.
 *
 * This is the architecture Tongyi was RL-trained for — it lost as a bounded single-stage model;
 * the specialist is expected to pay off when it owns the loop. Everything is dependency-injected
 * (search/read/chat ports) so the whole thing is unit-testable offline with fakes — no M5, no
 * network, no keys (mirroring deep-research.ts).
 */

import type {
  ResearchRequest,
  ResearchDeps,
  ResearchResult,
  ResearchReport,
  ResearchStats,
  ReportSection,
  Source,
  ReadResult,
  PopularSummary,
  ChatFn,
  ReportCitationCheck,
} from "./deep-research-types.js";
import type { DeepResearchConfig, AgentDialect } from "./deep-research-config.js";
// stripThink here is the UNCLOSED-aware variant (strips a truncated `<think>` to EOF) — essential
// for a reasoning model (Tongyi) that can run out of tokens mid-thought. (verifier.ts's strips only
// CLOSED blocks and would leak the raw reasoning into the report body.)
import { looseJson, assignSources, renderReport, splitPopular, buildPopularPrompt, stripThink } from "./deep-research.js";
import { dedupeAndRank } from "./search-provider.js";
import { nearDuplicate } from "./reader.js";
import { verifyReportSentences, autoAttributeCitations } from "./citation-verifier.js";

// ─── Loop tuning constants (the deterministic guardrails, in code) ──────────────────
/** Consecutive unparseable/unknown actions before the loop force-finalizes. */
const MAX_PARSE_FAILS = 3;
/** Consecutive turns adding no new source AND no answer before force-finalize (stall). */
const MAX_STALL_TURNS = 3;
/** How many recent search queries / read urls to remember for stall-nudging. */
const RECENT_MEMORY = 4;
/** Top-N search hits surfaced in a search observation. */
const SEARCH_OBS_HITS = 6;
/** A forced-finalize brain call gets a generous budget so it can write a full report. */
const FINALIZE_MAX_TOKENS = 6000;

// ─── Action protocol (pluggable dialect) ─────────────────────────────────────────────
// The protocol is the one seam that differs between the generic harness format and a
// model's native RL-trained format. Two dialects:
//   generic — `{"action":"search|read|reflect|answer",...}` JSON-per-turn (the harness's own).
//   tongyi  — Tongyi-DeepResearch-30B-A3B native in-text format (verified from the owner's
//             inference code, github.com/Alibaba-NLP/DeepResearch): `<tool_call>{name,arguments}
//             </tool_call>` actions (`search`/`visit`), `<answer>…</answer>` final, observations
//             wrapped in `<tool_response>…</tool_response>`.
// The LOOP CONTROLLER and every guardrail are dialect-agnostic — only parse/prompt/obs-wrap differ.

type AgentAction =
  | { action: "search"; query: string }
  | { action: "read"; urls: string[]; goal?: string }
  | { action: "reflect"; note: string }
  | { action: "answer"; report: string };

/** Parse ONE action from a (possibly prose / <think> / fenced) model turn. null = unparseable. */
export function parseAgentAction(text: string, dialect: AgentDialect = "generic"): AgentAction | null {
  return dialect === "tongyi" ? parseTongyiAction(text) : parseGenericAction(text);
}

/** Generic harness format: a single `{"action":…}` JSON object per turn. */
function parseGenericAction(text: string): AgentAction | null {
  const j = looseJson(text); // strips <think>, tolerates a ```json fence + an embedded {…} slice
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const action = typeof o.action === "string" ? o.action.toLowerCase() : "";
  switch (action) {
    case "search":
      return typeof o.query === "string" && o.query.trim() ? { action: "search", query: o.query.trim() } : null;
    case "read":
      return typeof o.url === "string" && o.url.trim() ? { action: "read", urls: [o.url.trim()] } : null;
    case "reflect":
      return { action: "reflect", note: typeof o.note === "string" ? o.note : "" };
    case "answer":
      return typeof o.report === "string" && o.report.trim() ? { action: "answer", report: o.report } : null;
    default:
      return null;
  }
}

/**
 * Tongyi-DR native parser. Grammar (from the model owner's prompt.py / react_agent.py):
 *   ACTION  := `<tool_call>\n{"name": <fn>, "arguments": <obj>}\n</tool_call>`
 *   ANSWER  := `<answer>…</answer>`
 * Tools: `search {"query": string[]}` (BATCH) and `visit {"url": string[], "goal"?: string}`.
 * `<answer>` wins if present (the model terminates with it). Otherwise the FIRST `<tool_call>` is
 * parsed leniently (json5: trailing commas / single quotes ok). Unknown tools / no tags → null.
 * Defensive code-strip: only text up to the first `</tool_call>`/`</answer>` is trusted, so trailing
 * hallucinated tags (when the backend ignores the `stop` sequence) can never inject a 2nd action.
 */
function parseTongyiAction(text: string): AgentAction | null {
  const stripped = stripThink(text);
  // `<answer>` terminates the run — prefer it even if a stray tool_call trails behind.
  const ans = /<answer>([\s\S]*?)<\/answer>/i.exec(stripped) ?? /<answer>([\s\S]*)$/i.exec(stripped);
  if (ans && ans[1] && ans[1].trim()) return { action: "answer", report: ans[1].trim() };

  // FIRST tool_call only (code-strip: ignore anything after its closing tag).
  const tc = /<tool_call>([\s\S]*?)<\/tool_call>/i.exec(stripped);
  if (!tc || !tc[1]) return null;
  const obj = looseJson5(tc[1]);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.toLowerCase() : "";
  const args = (o.arguments && typeof o.arguments === "object" ? o.arguments : {}) as Record<string, unknown>;

  if (name === "search") {
    // arguments.query is a STRING[] batch; use the FIRST (others ignored — single-query search port).
    const queries = toStringArray(args.query);
    return queries.length ? { action: "search", query: queries[0]! } : null;
  }
  if (name === "visit") {
    // arguments.url is a STRING[]; read them ALL in this turn (see handleRead loop).
    const urls = toStringArray(args.url);
    if (!urls.length) return null;
    const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal.trim() : undefined;
    return goal ? { action: "read", urls, goal } : { action: "read", urls };
  }
  // google_scholar / parse_file / PythonInterpreter and anything else are unsupported → unparseable.
  return null;
}

/** A string or string[] → trimmed non-empty string[]. */
function toStringArray(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

/**
 * Lenient (json5-style) parse of a `<tool_call>` inner object: tolerate trailing commas and
 * single-quoted strings/keys before falling back to the strict `looseJson` slice. Only the minimal
 * normalizations Tongyi actually emits — not a full JSON5 grammar.
 */
function looseJson5(inner: string): unknown {
  const strict = looseJson(inner);
  if (strict && typeof strict === "object") return strict;
  // Normalize: strip trailing commas before } or ], and convert single-quoted strings to double.
  const slice = inner.match(/[[{][\s\S]*[\]}]/);
  const candidate = (slice ? slice[0] : inner).trim();
  const normalized = candidate
    .replace(/'/g, '"') // single → double quotes (Tongyi sometimes single-quotes keys/values)
    .replace(/,(\s*[}\]])/g, "$1"); // drop trailing commas
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

// ─── System prompt (dialect-aware) ───────────────────────────────────────────────────

export function buildAgentSystemPrompt(
  query: string,
  maxTurns: number,
  dialect: AgentDialect = "generic",
  nowIso?: string
): string {
  return dialect === "tongyi"
    ? buildTongyiSystemPrompt(query, nowIso)
    : buildGenericSystemPrompt(query, maxTurns);
}

function buildGenericSystemPrompt(query: string, maxTurns: number): string {
  return [
    "You are an autonomous research agent. Investigate the question by issuing ONE action per turn,",
    "as a single JSON object on its own — no extra prose. After each action you receive an OBSERVATION.",
    "",
    `RESEARCH QUESTION: ${query}`,
    "",
    "Available actions (emit EXACTLY one JSON object per turn):",
    '  {"action":"search","query":"<keywords>"}   — run a web search; observation lists hits (url/title/snippet).',
    '  {"action":"read","url":"<url>"}             — fetch a page; observation gives it a source id "S#" and its text.',
    '  {"action":"reflect","note":"<thought>"}     — record a private thought; no external effect.',
    '  {"action":"answer","report":"<markdown>"}   — FINISH: your full research report in Markdown.',
    "",
    "RULES:",
    `- You have at most ${maxTurns} turns. Search broadly, READ the most authoritative pages, then answer.`,
    "- You may ONLY cite sources you have actually READ. Cite them by the S# id given in the READ observation,",
    "  using inline [S#] markers (e.g. [S1] or [S2][S4]) on every factual sentence of your final report.",
    "- Do NOT invent source ids or facts. If a page failed to load, do not cite it.",
    "- When you have enough evidence, emit the answer action with a well-structured, heavily-cited Markdown report.",
  ].join("\n");
}

/**
 * Tongyi-DeepResearch native system prompt (canonical structure from the model owner's prompt.py):
 * a deep-research preamble, a `# Tools` section, a `<tools>` block with one JSON function-signature
 * per line, the literal `<tool_call>` instruction, then the injected current date. The harness binds
 * only `search`/`visit` (others omitted) — and the source ids ([S#]) the deterministic verifier needs.
 */
function buildTongyiSystemPrompt(query: string, nowIso?: string): string {
  const date = (nowIso ?? "").slice(0, 10) || "(unknown)";
  const tools = [
    '{"name": "search", "description": "Run web searches. Accepts a batch of query strings; each returns ranked hits.", "parameters": {"type": "object", "properties": {"query": {"type": "array", "items": {"type": "string"}}}, "required": ["query"]}}',
    '{"name": "visit", "description": "Fetch and read one or more web pages toward a goal; each read page is assigned a source id S#.", "parameters": {"type": "object", "properties": {"url": {"type": "array", "items": {"type": "string"}}, "goal": {"type": "string"}}, "required": ["url", "goal"]}}',
  ].join("\n");
  return [
    "You are a deep research assistant. Your core function is to conduct thorough, multi-source investigation",
    "toward the user's question. Use the available tools to search the web and read authoritative pages, reason",
    "over what you find inside <think></think>, and — when you are ready — enclose the entire final answer",
    "within <answer></answer> tags as a well-structured, heavily-cited Markdown report.",
    "",
    `RESEARCH QUESTION: ${query}`,
    "",
    "CITATIONS ARE MANDATORY. Each page you read via `visit` is assigned a source id (S1, S2, …), shown in its",
    "<tool_response>. In your <answer>, EVERY factual sentence MUST end with the [S#] marker(s) of the source(s)",
    "it came from. For example, write a sentence exactly like:",
    '    "Moderate intake was associated with about a 15% lower risk [S1]."',
    "A factual sentence with no [S#] marker will be treated as UNSUPPORTED and counts against you. You may ONLY",
    "cite pages you actually read; do NOT invent source ids, urls, or facts. If a page failed to load, do not cite it.",
    "",
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    tools,
    "</tools>",
    "",
    "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-json-object>}',
    "</tool_call>",
    "",
    `Current date: ${date}`,
  ].join("\n");
}

// ─── Retry-on-blank brain wrapper ───────────────────────────────────────────────────

interface BrainTurn {
  text: string;
  completionTokens: number;
}

/** Extra sampling params threaded onto every brain call (dialect-specific: tongyi passes its native
 *  stop sequences + top_p/presence_penalty so generation halts before the injected observation). */
interface BrainSampling {
  stop?: string[];
  topP?: number;
  presencePenalty?: number;
}

/** Call the brain; if the body is blank after stripping <think>, retry up to `maxRetries`.
 *  Accumulates completion tokens across every attempt (each costs real compute). */
async function callBrain(
  brain: ChatFn,
  system: string,
  prompt: string,
  maxTokens: number,
  temperature: number,
  maxRetries: number,
  sampling: BrainSampling = {}
): Promise<BrainTurn> {
  let tokens = 0;
  let lastText = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let resp;
    try {
      resp = await brain({
        system,
        prompt,
        maxTokens,
        temperature,
        ...(sampling.stop ? { stop: sampling.stop } : {}),
        ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
        ...(sampling.presencePenalty !== undefined ? { presencePenalty: sampling.presencePenalty } : {}),
      });
    } catch {
      // Infra/network throw → treat as a blank turn (the loop's parse-failure path handles it).
      return { text: "", completionTokens: tokens };
    }
    tokens += resp.completionTokens;
    lastText = resp.text ?? "";
    if (stripThink(lastText).trim().length > 0) return { text: lastText, completionTokens: tokens };
  }
  return { text: lastText, completionTokens: tokens };
}

/** Tongyi-DR native sampling (verified from the owner's react_agent.py). Generic dialect uses {}. */
function dialectSampling(dialect: AgentDialect): BrainSampling {
  if (dialect !== "tongyi") return {};
  return { stop: ["\n<tool_response>", "<tool_response>"], topP: 0.95, presencePenalty: 1.1 };
}

/** Tongyi-DR native sampling temperature (0.6). Generic keeps the configured agentTemp. */
function dialectTemp(dialect: AgentDialect, configured: number): number {
  return dialect === "tongyi" ? 0.6 : configured;
}

/** Wrap a tool observation in the dialect's native framing for the next turn's prompt. */
function wrapObservation(dialect: AgentDialect, body: string): string {
  return dialect === "tongyi" ? `<tool_response>\n${body}\n</tool_response>` : `OBSERVATION: ${body}`;
}

/** Echo the parsed action back into the transcript in the dialect's native shape (so the model sees
 *  a consistent, code-sanitized record of what it actually did — never the raw, possibly-trailing-
 *  garbage turn). Search/visit only; answer/reflect terminate or note before this is rendered. */
function echoAction(dialect: AgentDialect, action: AgentAction): string {
  if (dialect !== "tongyi") return JSON.stringify(action);
  if (action.action === "search") {
    return `<tool_call>\n${JSON.stringify({ name: "search", arguments: { query: [action.query] } })}\n</tool_call>`;
  }
  if (action.action === "read") {
    const args = action.goal ? { url: action.urls, goal: action.goal } : { url: action.urls };
    return `<tool_call>\n${JSON.stringify({ name: "visit", arguments: args })}\n</tool_call>`;
  }
  return JSON.stringify(action);
}

// ─── Report parsing (markdown body → sections) ──────────────────────────────────────

/** Split a markdown body into sections by `#`/`##`… headings. No heading → one "Report" section. */
export function parseSections(body: string): ReportSection[] {
  const lines = body.split("\n");
  const sections: ReportSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const md = buf.join("\n").trim();
    if (heading || md) sections.push({ heading: heading || "Report", markdown: md });
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1]!.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  if (sections.length === 0) return [{ heading: "Report", markdown: body.trim() }];
  return sections;
}

// ─── Finalize ───────────────────────────────────────────────────────────────────────

function emptyStats(): ResearchStats {
  return {
    iterations: 0,
    searchQueries: 0,
    sourcesFetched: 0,
    sourcesDistilled: 0,
    claimsExtracted: 0,
    claimsDisputed: 0,
    citationPrecision: 1,
    reportSentencePrecision: 1,
    totalCompletionTokens: 0,
    modelCalls: {},
  };
}

interface FinalizeInput {
  query: string;
  nowIso: string;
  body: string;
  sources: Source[];
  turns: number;
  stats: ResearchStats;
}

/** Build the ResearchReport + popular summary from a final report body + read sources. The agent
 *  reads full pages (no distilled-claim stage), so `citations` (claim→source) is vacuously precise
 *  and the report-sentence verifier is the trust anchor. */
async function finalize(deps: ResearchDeps, fin: FinalizeInput): Promise<ResearchResult> {
  const { query, nowIso, sources, turns, stats } = fin;
  const cfg = deps.config;

  // Auto-attribution (issue #46): Tongyi-DR answers grounded-but-uncited, so the trust anchor would
  // see 0/0 cited sentences. Deterministically attach [S#] to each substantive uncited sentence that
  // actually appears in a read source (same hardened matcher + guards; never fabricates). Gated on
  // `agentAutoCite` (default ON for tongyi, OFF for the self-citing generic dialect). Runs BEFORE the
  // verifier + render so the report is graded WITH the recovered citations.
  const body = cfg.agentAutoCite
    ? autoAttributeCitations(fin.body, sources, { threshold: cfg.reportSentenceMatchThreshold })
    : fin.body;

  const reportCitations: ReportCitationCheck = verifyReportSentences({
    reportBody: body,
    sources,
    threshold: cfg.reportSentenceMatchThreshold,
  });
  stats.reportSentencePrecision = reportCitations.precision;
  stats.citationPrecision = 1;
  stats.iterations = turns;
  stats.sourcesFetched = sources.length;
  stats.modelCalls = { ...stats.modelCalls, agent: turns };

  const markdown = renderReport({
    query,
    generatedAtIso: nowIso,
    brain: "local",
    iterations: turns,
    body,
    sources,
    disputed: [],
    citationPrecision: 1,
    reportCitations,
  });

  const report: ResearchReport = {
    query,
    generatedAtIso: nowIso,
    sections: parseSections(body),
    disputed: [],
    sources,
    brain: "local",
    iterations: turns,
    citations: { resolved: [], unresolved: [], precision: 1 },
    reportCitations,
    markdown,
  };

  const popular = await buildPopular(deps, query, markdown, body, sources, stats);
  return { report, popular, stats };
}

/** One brain call for the accessible summary; fall back to a real (non-empty) minimal summary. */
async function buildPopular(
  deps: ResearchDeps,
  query: string,
  reportMarkdown: string,
  body: string,
  sources: Source[],
  stats: ResearchStats
): Promise<PopularSummary> {
  const cfg = deps.config;
  const popReq = buildPopularPrompt(query, reportMarkdown);
  try {
    const resp = await deps.chat.planner({
      system: popReq.system,
      prompt: popReq.prompt,
      maxTokens: FINALIZE_MAX_TOKENS,
      temperature: cfg.agentTemp,
    });
    stats.totalCompletionTokens += resp.completionTokens;
    stats.modelCalls.popular = (stats.modelCalls.popular ?? 0) + 1;
    const text = stripThink(resp.text ?? "");
    if (text.trim().length > 80) return splitPopular(text);
  } catch {
    /* fall through to the deterministic minimal summary */
  }
  // Minimal, real summary derived from the report (never empty, never hallucinated).
  const title = `Research summary: ${query}`.slice(0, 140);
  const srcLine = sources.length
    ? `Based on ${sources.length} source${sources.length === 1 ? "" : "s"} read.`
    : "No sources were available.";
  return { title, markdown: `${title}\n\n${srcLine}\n\n${body.trim()}` };
}

// ─── The ReAct loop ──────────────────────────────────────────────────────────────────

/**
 * Model-driven ReAct research. The brain (`deps.chat.planner`) chooses search/read/reflect/answer
 * each turn; the harness enforces every budget and safety bound in code and finalizes through the
 * deterministic citation verifier.
 */
export async function runAgentResearch(deps: ResearchDeps, req: ResearchRequest): Promise<ResearchResult> {
  const cfg: DeepResearchConfig = deps.config;
  const log = deps.log ?? (() => {});
  const progress = deps.onProgress;

  const dialect: AgentDialect = cfg.agentDialect;
  const sampling = dialectSampling(dialect);
  const temp = dialectTemp(dialect, cfg.agentTemp);

  const stats = emptyStats();
  const system = buildAgentSystemPrompt(req.query, cfg.agentMaxTurns, dialect, req.nowIso);

  const sources: Source[] = [];
  const seenUrls = new Set<string>();
  const recentQueries: string[] = [];
  const recentUrls: string[] = [];

  // Dialect-specific "your turn" nudge appended to the transcript each call.
  const nextNudge =
    dialect === "tongyi"
      ? "Emit your next tool_call, or your final <answer>…</answer>."
      : "Emit your next action as a single JSON object.";
  const firstNudge =
    dialect === "tongyi"
      ? "Begin your research. Emit your first tool_call (search or visit)."
      : "Begin. Emit your first action as a single JSON object.";

  // The growing ReAct transcript: alternating ACTION / OBSERVATION blocks fed back each turn.
  const transcript: string[] = [];
  const transcriptText = () =>
    transcript.length === 0 ? firstNudge : transcript.join("\n\n") + "\n\n" + nextNudge;

  // Native parse-failure nudge per dialect.
  const parseFailObs =
    dialect === "tongyi"
      ? "Could not parse a tool_call. Respond with EXACTLY one <tool_call>{\"name\":\"search|visit\",\"arguments\":{…}}</tool_call>, " +
        "or your final answer inside <answer></answer>."
      : "Could not parse an action. Respond with EXACTLY one JSON action: " +
        '{"action":"search","query":...} | {"action":"read","url":...} | {"action":"reflect","note":...} | {"action":"answer","report":...}.';

  let consecutiveParseFails = 0;
  let stallTurns = 0;
  let answerBody: string | null = null;
  let turn = 0;

  while (turn < cfg.agentMaxTurns && stats.totalCompletionTokens < cfg.agentTokenBudget) {
    turn++;
    stats.iterations = turn;
    progress?.({ stage: "plan", iteration: turn, detail: `agent turn ${turn}` });

    const brainTurn = await callBrain(
      deps.chat.planner,
      system,
      transcriptText(),
      Math.max(cfg.plannerMinTokens, 2000),
      temp,
      cfg.agentMaxBlankRetries,
      sampling
    );
    stats.totalCompletionTokens += brainTurn.completionTokens;

    const action = parseAgentAction(brainTurn.text, dialect);

    // ── Parse failure (blank, prose, or unknown action) ──
    if (!action) {
      consecutiveParseFails++;
      log(`turn ${turn}: unparseable action (${consecutiveParseFails}/${MAX_PARSE_FAILS})`);
      transcript.push(stripThink(brainTurn.text).slice(0, 400) || "(blank)");
      transcript.push(wrapObservation(dialect, parseFailObs));
      if (consecutiveParseFails >= MAX_PARSE_FAILS) {
        log(`force-finalize: ${MAX_PARSE_FAILS} consecutive parse failures`);
        break;
      }
      continue;
    }
    consecutiveParseFails = 0;
    transcript.push(echoAction(dialect, action));

    if (action.action === "answer") {
      answerBody = action.report;
      progress?.({ stage: "synthesize", iteration: turn, detail: "agent emitted answer" });
      break;
    }

    if (action.action === "reflect") {
      transcript.push(wrapObservation(dialect, "noted."));
      stallTurns++; // reflection adds no source and no answer
      if (stallTurns >= MAX_STALL_TURNS) {
        log(`force-finalize: ${MAX_STALL_TURNS} turns with no progress`);
        break;
      }
      continue;
    }

    if (action.action === "search") {
      stats.searchQueries++;
      progress?.({ stage: "search", iteration: turn, detail: action.query });
      const repeat = recentQueries.includes(action.query);
      pushRecent(recentQueries, action.query);
      let hits;
      try {
        hits = await deps.search.search(action.query);
      } catch (e) {
        transcript.push(
          wrapObservation(dialect, `search failed: ${(e as Error).message}. Try a different query or read a known url.`)
        );
        stallTurns++;
        if (stallTurns >= MAX_STALL_TURNS) break;
        continue;
      }
      const ranked = dedupeAndRank(hits, { seenUrls }).slice(0, SEARCH_OBS_HITS);
      const nudge = repeat ? " (NOTE: you already ran this query — try new keywords or read a result.)" : "";
      const obs = ranked.length
        ? ranked.map((h, i) => `  ${i + 1}. ${h.title} — ${h.url}\n     ${h.snippet}`).join("\n")
        : "(no new results)";
      transcript.push(wrapObservation(dialect, `search results${nudge}:\n${obs}`));
      stallTurns++; // a search alone adds no source
      if (stallTurns >= MAX_STALL_TURNS) {
        log(`force-finalize: ${MAX_STALL_TURNS} turns with no new source`);
        break;
      }
      continue;
    }

    // action.action === "read" — may carry MULTIPLE urls (tongyi `visit` batches them).
    progress?.({ stage: "read", iteration: turn, detail: action.urls.join(", ") });
    let addedAny = false;
    const obsParts: string[] = [];
    for (const url of action.urls) {
      const obs = await handleRead(deps, url, sources, seenUrls, recentUrls, cfg);
      obsParts.push(obs.text);
      if (obs.addedSource) addedAny = true;
    }
    transcript.push(wrapObservation(dialect, obsParts.join("\n\n")));
    if (addedAny) {
      stats.sourcesFetched = sources.length;
      stallTurns = 0;
    } else {
      stallTurns++;
      if (stallTurns >= MAX_STALL_TURNS) {
        log(`force-finalize: ${MAX_STALL_TURNS} turns with no new source`);
        break;
      }
    }
  }

  // ── Force-finalize when the loop ended without a usable answer ──
  if (answerBody === null || stripThink(answerBody).trim().length === 0) {
    answerBody = await forceFinalize(deps, system, transcriptText(), sources, stats, cfg);
  }

  // In tongyi dialect a force-finalize may still wrap the report in <answer>…</answer>; unwrap it so
  // those tags never leak into the rendered report (the in-loop answer path already strips them).
  const body = unwrapAnswerTags(dialect, stripThink(answerBody)).trim();
  return finalize(deps, { query: req.query, nowIso: req.nowIso, body, sources, turns: stats.iterations, stats });
}

/** Strip any `<answer>…</answer>` framing from a tongyi report body (extract the inner text if the
 *  tags wrap the whole report; otherwise just drop stray tags). No-op for the generic dialect. */
function unwrapAnswerTags(dialect: AgentDialect, text: string): string {
  if (dialect !== "tongyi") return text;
  const m = /<answer>([\s\S]*?)<\/answer>/i.exec(text) ?? /<answer>([\s\S]*)$/i.exec(text);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  return text.replace(/<\/?answer>/gi, "");
}

/** Track the last `RECENT_MEMORY` items for stall/repeat detection. */
function pushRecent(arr: string[], item: string): void {
  arr.push(item);
  while (arr.length > RECENT_MEMORY) arr.shift();
}

interface ReadObservation {
  text: string;
  addedSource: boolean;
}

/** Execute a read action: dedup by url + near-dup, SSRF/timeout inherited from reader.read (try/catch). */
async function handleRead(
  deps: ResearchDeps,
  url: string,
  sources: Source[],
  seenUrls: Set<string>,
  recentUrls: string[],
  cfg: DeepResearchConfig
): Promise<ReadObservation> {
  // Already read this exact url?
  if (seenUrls.has(url)) {
    const existing = sources.find((s) => s.url === url);
    return { text: `already have this as ${existing ? existing.id : "a prior source"}.`, addedSource: false };
  }
  seenUrls.add(url);
  pushRecent(recentUrls, url);

  let read: ReadResult;
  try {
    read = await deps.read.read(url);
  } catch (e) {
    return { text: `read failed: ${(e as Error).message}`, addedSource: false };
  }
  if (read.markdown.trim().length === 0) {
    return { text: `read returned no usable text for ${url}.`, addedSource: false };
  }
  // Near-duplicate of an existing source? (assignSources collapses page-internal dups; this guards
  // cross-call dups where the same content arrives under a different url.)
  if (sources.some((s) => nearDuplicate(s.markdown, read.markdown))) {
    const dup = sources.find((s) => nearDuplicate(s.markdown, read.markdown))!;
    return { text: `already have this content as ${dup.id} (near-duplicate).`, addedSource: false };
  }

  // assignSources gives the next S# id, tier, contentHash, and drops empty pages.
  const [src] = assignSources([read], sources.length);
  if (!src) return { text: `read returned no usable text for ${url}.`, addedSource: false };
  sources.push(src);

  const cap = cfg.agentReadCharCap;
  const text = read.markdown.length > cap ? read.markdown.slice(0, cap) + " …[truncated]" : read.markdown;
  // Lead with the bracketed id so the model sees the exact [S#] citation token to reuse in its answer.
  return { text: `[${src.id}] "${src.title}" (${src.url}) — cite this source as [${src.id}]:\n${text}`, addedSource: true };
}

/**
 * Budget reached without an answer: make ONE final brain call asking for the report now.
 * If that is blank/unusable, fall back to a deterministic source listing (or an explicit
 * "insufficient sources" body when nothing was read — never hallucinate).
 */
async function forceFinalize(
  deps: ResearchDeps,
  system: string,
  transcript: string,
  sources: Source[],
  stats: ResearchStats,
  cfg: DeepResearchConfig
): Promise<string> {
  const dialect: AgentDialect = cfg.agentDialect;
  const isTongyi = dialect === "tongyi";
  const prompt =
    `${transcript}\n\n` +
    (isTongyi
      ? "Budget reached — output your FINAL research report NOW inside <answer></answer> tags as Markdown with "
      : "Budget reached — output your FINAL research report NOW as Markdown with ") +
    "[S#] citations to the sources you read. Cite ONLY sources that appear in the read observations above. " +
    "Do not invent facts. Respond with the report only (no tool calls, no preamble).";
  // Finalize asks for the full report, NOT a tool_call → do not pass the `<tool_response>` stop
  // (it would not fire, but keeping the report free of stop interference is cleaner). Keep top_p /
  // presence_penalty so the dialect's sampling profile is consistent.
  const finalizeSampling = isTongyi ? { topP: 0.95, presencePenalty: 1.1 } : {};
  const turn = await callBrain(
    deps.chat.planner,
    system,
    prompt,
    Math.max(cfg.plannerMinTokens, FINALIZE_MAX_TOKENS),
    dialectTemp(dialect, cfg.agentTemp),
    cfg.agentMaxBlankRetries,
    finalizeSampling
  );
  stats.totalCompletionTokens += turn.completionTokens;
  stats.modelCalls.agent = (stats.modelCalls.agent ?? stats.iterations) + 1;

  const body = stripThink(turn.text).trim();
  if (body.length > 0) return body;

  // Deterministic fallback — real content only, no fabrication.
  if (sources.length === 0) {
    return "No sources could be retrieved; the research question could not be answered from available evidence. (insufficient sources)";
  }
  const lines = sources.map((s) => `- ${s.title} [${s.id}](${s.url})`).join("\n");
  return `## Sources read\n\nThe agent gathered the following sources but did not produce a synthesized answer within budget:\n\n${lines}`;
}
