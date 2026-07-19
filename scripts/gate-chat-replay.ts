/**
 * gate-chat-replay.ts — the disagreement gate over REAL chat/ask traffic, OFFLINE.
 *
 * Why offline rather than a live hook in `runChatCompletion`/`handleChatProxy`: the chat path
 * serves LOCAL models only — there is no frontier escalation there — so a gate on it can only ever
 * be observability. The owner's chat/ask responses are ALREADY captured in `owner_request_log`, and
 * running a second model live per request would force a mellum→qwen swap on the serial GPU (the #88
 * thrash) for data we can get for free. So this tool reproduces the gate's signal on the real chat
 * stream with ZERO impact on live serving: for each logged request it runs ONLY the secondary model
 * on the same messages and scores disagreement against the ACTUAL served response (the logged
 * completion) — using the SAME production heuristics the live `/delegate` gate uses
 * (`disagreementScore`/`gateDecision`).
 *
 * It is READ-ONLY on the database (reads owner_request_log; writes nothing to the ledger) and does
 * NOT call the frontier, so there is no OpenRouter spend. Wrap it in the GPU lease so the secondary
 * swaps don't collide with another owner session; it is safe to schedule (e.g. nightly):
 *
 *   cd /srv/gille-inference
 *   npx tsx src/homeserver/cli.ts gpu run --model gate-chat-replay --eta 30m --purpose gate-chat-replay \
 *     -- npx tsx scripts/gate-chat-replay.ts --n 40 --recent 24h
 *
 * Flags:
 *   --n <int>            number of requests to sample (stride-sampled across the window; default 20)
 *   --recent <dur>       restrict to the last <dur> of traffic (<number><m|h|d|w>, e.g. 24h, 7d)
 *   --since <date|iso>   restrict to traffic at/after a YYYY-MM-DD date or ISO timestamp
 *   --task-types <csv>   restrict to these taxonomy task types only (e.g. extract,classify,qa-factual).
 *                        Validated eagerly against the taxonomy — an unknown id is a hard error
 *                        listing the valid ones (a typo must not silently produce an empty filter).
 *                        The filter narrows the SAMPLING POOL before `--n`'s stride-sampling cap is
 *                        applied, so `--n 60 --task-types extract` means "60 rows OF THAT TYPE", not
 *                        "60 rows, then keep whichever happen to be extract" (#201 fix-forward: the
 *                        7.5% launch fire-rate was measured on a benchmark-flood of short extract/
 *                        classify leaf tasks; a like-for-like re-run needs to sample ONLY the task
 *                        types the output-similarity scorer was actually validated against).
 *   --count-only         report eligible-row counts by task type for the window/filter and EXIT —
 *                        makes ZERO model calls (returns before the replay loop) — use it to size
 *                        `--n` before spending GPU time.
 * Without a window it samples ALL-TIME (the prior behaviour). A window makes the nightly trend
 * reflect recent usage rather than the damped all-time average. `--since` wins if both are given.
 *
 * Per-request results → data/gate-chat-replay-<n>.jsonl.
 */
import Database from "better-sqlite3";
import { writeFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gateDecision } from "../src/homeserver/disagreement-gate.js";
import { classifyTask, isKnownTaskType, TASK_TYPES } from "../src/homeserver/taxonomy.js";
import { loadConfig } from "../src/homeserver/config.js";

const DB_PATH = process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
const CALL_TIMEOUT_MS = Number(process.env["GATE_CALL_TIMEOUT_MS"] ?? 600_000);

/**
 * Read a `--flag <value>` pair, validating arity: returns undefined if the flag is absent, the
 * value if present, and THROWS if the flag is given with no value or with another `--flag` next
 * (so a trailing/empty `--recent`/`--since` can't silently fall through to the all-time path).
 */
export function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${name}: missing value (expected a value, got ${v === undefined ? "end of args" : JSON.stringify(v)})`);
  }
  return v;
}

/**
 * Below this many scored requests, a fire-rate percentage is statistically noise, not signal —
 * found live on the box: the nightly trend degraded to n=3-5 (real owner_request_log chat volume
 * dropped) while fireRatePct read 100%, which looks like a severe regression but is actually 3-5
 * coin flips. 20 is a pragmatic floor (not a formal power calculation) — comfortably above "one or
 * two hard queries dominate the percentage" territory, comfortably below the historical n=60 target.
 */
export const DEFAULT_MIN_RELIABLE_N = 20;

/** One night's structured offloadability summary — the spine for the Heimdall trend panel. */
/**
 * Loader interpretation-policy epoch, stamped on every new trend record (#222 review): how logged
 * messages are turned into (task, messages) changes what population is ELIGIBLE for the replay, so
 * cross-epoch fire-rate comparisons are apples-to-oranges without a stamp. Lineage:
 *   (unstamped)         — pre-#216: tool/unknown roles coerced to user; parts content dropped
 *   "content-parts-v1"  — #216 (tool role preserved, task = genuine user turn) + #222 (array-of-
 *                         parts content flattened to its text parts; agentic lane eligible)
 * Bump this when the loader's interpretation of logged messages changes again.
 */
export const LOADER_POLICY = "content-parts-v1";

export interface TrendRecord {
  ts: string;
  date: string;
  window: string;
  /** Loader interpretation-policy epoch this run's eligible population was built under (#222).
   *  Absent on rows written before 2026-07-11 (pre-#216 semantics). */
  loaderPolicy?: string;
  n: number;
  secondaryErrors: number;
  wouldEscalate: number;
  fireRatePct: number;
  byModel: { model: string; disagree: string }[];
  /**
   * Per-task-type breakdown (#201) — mirrors `byModel`. Added after an 8-night 7.5%→94.7%
   * fire-rate spike turned out to trace back to a TRAFFIC-MIX shift (structured leaf sub-tasks
   * like extract/classify replaced by open-ended long-form synthesis and agentic tool-loop
   * traffic that the Jaccard-based scorer was never validated against) — a shift that was only
   * reconstructable after the fact by grepping the append-only console log, because the
   * per-request JSONL detail (which DOES carry taskType) gets overwritten across nights that
   * sample the same n (see `resultsOutputPath`). This field survives in the append-only trend
   * spine itself so a future mix shift is visible from `gate-chat-replay-trend.jsonl` alone.
   */
  byTaskType: { taskType: string; disagree: string }[];
  /**
   * The `--task-types` filter applied to this run, when the flag was used (#201 fix-forward: a
   * stratified re-run restricted to task types the output-similarity scorer is still valid for).
   * Present ONLY when the flag was used — an unfiltered (all task types) run omits this key
   * entirely, so existing trend rows and readers that don't expect it (e.g. `isTrendRecord`,
   * which only checks required fields) are unaffected.
   */
  taskTypesFilter?: string[];
  sampledFrom: string | null;
  sampledTo: string | null;
  /** True when `n` is below the reliability floor — fireRatePct for this run should be read as
   *  noise, not a real trend movement. See DEFAULT_MIN_RELIABLE_N. */
  lowSample: boolean;
}

/** Build a machine-readable trend record from a completed replay run (pure → testable). */
export function buildTrendRecord(p: {
  nowIso: string;
  windowShort: string;
  okCount: number;
  errCount: number;
  wouldEscalateCount: number;
  byModel: { model: string; n: number; esc: number }[];
  /** Optional for backward compatibility with existing call sites/tests; defaults to []. */
  byTaskType?: { taskType: string; n: number; esc: number }[];
  /** The `--task-types` filter applied to this run, when the flag was used. Omitted (undefined
   *  or empty) → the built record leaves `taskTypesFilter` off entirely (see TrendRecord). */
  taskTypesFilter?: string[];
  sampledTsSorted: string[];
  minReliableN?: number;
}): TrendRecord {
  const record: TrendRecord = {
    ts: p.nowIso,
    date: p.nowIso.slice(0, 10),
    window: p.windowShort,
    loaderPolicy: LOADER_POLICY,
    n: p.okCount,
    secondaryErrors: p.errCount,
    wouldEscalate: p.wouldEscalateCount,
    fireRatePct: p.okCount ? Math.round((p.wouldEscalateCount / p.okCount) * 1000) / 10 : 0,
    byModel: p.byModel.map((m) => ({ model: m.model, disagree: `${m.esc}/${m.n}` })),
    byTaskType: (p.byTaskType ?? []).map((t) => ({ taskType: t.taskType, disagree: `${t.esc}/${t.n}` })),
    sampledFrom: p.sampledTsSorted[0] ?? null,
    sampledTo: p.sampledTsSorted[p.sampledTsSorted.length - 1] ?? null,
    lowSample: p.okCount < (p.minReliableN ?? DEFAULT_MIN_RELIABLE_N),
  };
  if (p.taskTypesFilter && p.taskTypesFilter.length > 0) record.taskTypesFilter = p.taskTypesFilter;
  return record;
}

/**
 * Parse a `--task-types <csv>` flag into a validated set of taxonomy task-type ids (#201
 * fix-forward: a stratified re-run restricted to task types the output-similarity scorer is
 * valid for). Validates EAGERLY against the taxonomy's known ids (`isKnownTaskType`) so a typo
 * (e.g. `qa_factual` for `qa-factual`) surfaces as a listed, hard error rather than silently
 * producing a filter that matches nothing. Returns `null` when the flag is absent — no filtering,
 * replay behaves exactly as before.
 */
export function parseTaskTypesFilter(csv: string | undefined): Set<string> | null {
  if (csv === undefined) return null;
  const ids = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(`--task-types: expected a comma-separated list of task types, got an empty value`);
  }
  const unknown = [...new Set(ids.filter((id) => !isKnownTaskType(id)))];
  if (unknown.length > 0) {
    const valid = TASK_TYPES.map((t) => t.id).join(", ");
    throw new Error(`--task-types: unknown task type(s): ${unknown.join(", ")}. Valid task types: ${valid}`);
  }
  return new Set(ids);
}

/**
 * Aggregate already-loaded rows into a task-type count report — pure, no I/O, no access to
 * `chat`/`fetch` at all. Used by `--count-only` so its "zero inference calls" guarantee is
 * structural (this function CANNOT make a model call), not just an empirically-observed property
 * of the surrounding control flow.
 */
export function buildCountReport(rows: { taskType: string }[]): {
  total: number;
  byTaskType: { taskType: string; n: number }[];
} {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.taskType, (counts.get(r.taskType) ?? 0) + 1);
  return {
    total: rows.length,
    byTaskType: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([taskType, n]) => ({ taskType, n })),
  };
}

/**
 * Per-request detail output path for one replay run (#201). Stamped with the FULL run timestamp
 * (filesystem-safe), not just the calendar date: two nights with the same n must not collide,
 * and neither may a same-day manual rerun during an investigation — the exact scenario that
 * destroyed the 06-28/06-29 per-request evidence. Pure/exported for testing.
 */
export function resultsOutputPath(nowIso: string, n: number): string {
  const stamp = nowIso.replace(/[:.]/g, "-");
  return `data/gate-chat-replay-${stamp}-${n}.jsonl`;
}

/** Parse a `--recent` duration (`<number><m|h|d|w>`, e.g. `24h`, `7d`, `90m`, `2w`) into ms. */
export function parseDurationMs(s: string): number {
  const m = /^(\d+)\s*([mhdw])$/.exec(s.trim());
  if (!m) throw new Error(`--recent: expected <number><m|h|d|w> (e.g. 24h, 7d), got: ${JSON.stringify(s)}`);
  const n = Number(m[1]);
  if (n <= 0) throw new Error(`--recent: quantity must be positive, got: ${JSON.stringify(s)}`);
  const mult = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : m[2] === "d" ? 86_400_000 : 604_800_000;
  return n * mult;
}

/**
 * Resolve the replay time-window into an inclusive ISO cutoff over `owner_request_log.ts`
 * (ISO-8601 UTC text, lexicographically ordered → a string `>=` is a chronological filter).
 *   --recent <dur>  → cutoff = now − dur
 *   --since  <iso>  → an ISO-8601 timestamp or a bare YYYY-MM-DD date (midnight UTC)
 * `--since` wins if both are given; neither → all-time (null cutoff). `now` is injectable for tests.
 */
export function parseWindow(opts: { recent?: string; since?: string; now?: number }): {
  sinceIso: string | null;
  label: string;
} {
  const now = opts.now ?? Date.now();
  if (opts.since !== undefined) {
    const s = opts.since.trim();
    // owner_request_log.ts is UTC (new Date().toISOString()). A timezone-less datetime would be
    // read by Date.parse as LOCAL time and silently shift the cutoff — so require either a bare
    // YYYY-MM-DD (midnight UTC) or a full ISO timestamp with an explicit Z / numeric offset.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
    const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
    if (!dateOnly && !hasTz) {
      throw new Error(
        `--since: ambiguous timestamp ${JSON.stringify(opts.since)} — use YYYY-MM-DD or a full ISO timestamp with Z/offset (e.g. 2026-06-25T06:30:00Z)`
      );
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`--since: not a valid date/ISO timestamp: ${JSON.stringify(opts.since)}`);
    const iso = new Date(t).toISOString();
    return { sinceIso: iso, label: `since ${iso}` };
  }
  if (opts.recent !== undefined) {
    const iso = new Date(now - parseDurationMs(opts.recent)).toISOString();
    return { sinceIso: iso, label: `last ${opts.recent} (since ${iso})` };
  }
  return { sinceIso: null, label: "all-time" };
}

interface ChatMsg { role: "system" | "user" | "assistant" | "tool"; content: string }

/**
 * Usable text of a logged message content: strings pass through; OpenAI ARRAY-OF-PARTS content is
 * flattened by joining its text parts in order (#222 — the pi harness sends the genuine ask as
 * `[{type:"text", text}]`, and dropping it excluded the whole agentic lane from evidence).
 * Non-text parts (images etc.) are ignored; anything else yields "" (turn dropped by the caller).
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: unknown; text: unknown } => !!p && typeof p === "object" && !Array.isArray(p)
    )
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() !== "")
    .map((p) => p.text as string)
    .join("\n");
}

/**
 * Logged messages_json → the known role/content shape. `tool` is preserved (#216): coercing it to
 * `user` made the trailing tool RESULT of an agentic loop the last "user" turn — selected as the
 * judged/classified TASK and the dedup key while the real human ask slid into prior context.
 * Unknown roles still coerce to `user`; array-of-parts content is flattened to its text (#222);
 * assistant tool_call stubs (content null) and textless turns are still dropped — the tool RESULT
 * carries the signal.
 */
function sanitizeMessages(parsed: unknown): ChatMsg[] {
  if (!Array.isArray(parsed)) return [];
  const ok: ChatMsg[] = [];
  for (const m of parsed) {
    if (!m || typeof m !== "object") continue;
    const r = m as { role?: unknown; content?: unknown };
    const text = contentText(r.content);
    if (!text.trim()) continue;
    const role =
      r.role === "system" || r.role === "assistant" || r.role === "tool" ? r.role : "user";
    ok.push({ role, content: text });
  }
  return ok;
}

/**
 * Replay payload for the secondary call: `tool` turns are sent as `user`. The sanitizer strips
 * tool_call_id/tool_calls, so a bare role:"tool" message is chat-template-hostile on llama.cpp —
 * and coercing at SEND time keeps the replayed request byte-identical to the pre-#216 payload
 * FOR STRING-CONTENT ROWS (the fire-rate trend's bulk); parts-content rows weren't eligible at
 * all pre-#222, so their payload is new, not changed — the population shift is what the trend
 * record's `loaderPolicy` stamp records. Task identity, classification, and dedup upstream see
 * the true roles.
 */
export function toReplayMessages(messages: ChatMsg[]): ChatMsg[] {
  return messages.map((m) => (m.role === "tool" ? { role: "user", content: m.content } : m));
}

/** One non-streaming chat completion against the local OpenAI-compatible endpoint (llama-swap). */
async function chat(baseUrl: string, model: string, messages: ChatMsg[], maxTokens: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    // An empty/blank secondary completion is a model FAILURE (the live gate treats it so), not an
    // answer — scoring it as max disagreement would inflate the fire-rate. Surface it as an error.
    if (typeof content !== "string" || content.trim() === "") throw new Error("empty secondary completion");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Max tokens the secondary may generate — a served response longer than this can't be compared
 *  fairly (the secondary would be budget-truncated → phantom disagreement), so such rows are skipped. */
const SECONDARY_MAX_TOKENS = 8192;

interface LoggedRow {
  id: number;
  ts: string;
  model: string;
  messages: ChatMsg[];
  completion: string;
  /** Served-response length in tokens — from the logged usage, else estimated from the text. */
  servedTokens: number;
  /** Classified via `classifyTask` on the last user turn — computed once here so both the
   *  `--task-types` filter and the replay/report loops share a single, consistent classification. */
  taskType: string;
}

/**
 * Deduped, stride-sampled real chat/ask requests that have a usable input AND a served response.
 * `sinceIso` (when non-null) restricts to rows logged at/after that ISO cutoff so the replay can
 * reflect a recent window (e.g. last 24h) rather than all-time.
 * `taskTypesFilter` (when non-null), applied BEFORE the stride-sampling `limit` is imposed, so
 * `limit` rows OF THOSE TYPES are returned rather than `limit` rows of any type post-filtered down
 * to fewer (or zero) matches (#201 fix-forward).
 */
export function loadChatRequests(
  secondaryModel: string,
  limit: number,
  sinceIso: string | null,
  dbPath: string = DB_PATH,
  taskTypesFilter: Set<string> | null = null
): LoggedRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, ts, model, messages_json, completion, completion_tokens
         FROM owner_request_log
         WHERE messages_json IS NOT NULL AND completion IS NOT NULL AND length(completion) >= 1
           AND outcome = 'ok' AND route IN ('chat', 'mcp')
           AND (@since IS NULL OR ts >= @since)
         ORDER BY id DESC`
      )
      .all({ since: sinceIso }) as { id: number; ts: string; model: string | null; messages_json: string; completion: string; completion_tokens: number | null }[];
    const eligible: LoggedRow[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      // Skip rows served BY the secondary model — a model can't disagree with itself (temp 0 → echo).
      if (r.model === secondaryModel) continue;
      if (!r.completion.trim()) continue;
      // Use logged usage when present, else estimate ~4 chars/token. Skip rows whose served response
      // exceeds the secondary's budget, so a forced truncation can't masquerade as disagreement.
      const servedTokens = r.completion_tokens ?? Math.ceil(r.completion.length / 4);
      if (servedTokens > SECONDARY_MAX_TOKENS) continue;
      const msgs = sanitizeMessages(safeParse(r.messages_json));
      if (msgs.length === 0) continue;
      // The GENUINE human ask (#216: tool results no longer coerce to user, so an agentic row
      // ending in a tool result keys on the real ask; a row with no human turn at all is skipped).
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (!lastUser || lastUser.content.trim().length < 20) continue;
      // Classify + apply the task-type filter BEFORE dedup/stride-sampling — the filter must
      // narrow the SAMPLING POOL itself (#201 fix-forward), not post-filter an already `limit`-
      // capped result (which could silently return far fewer than `limit`, or zero, matches).
      const taskType = classifyTask(lastUser.content).taskType;
      if (taskTypesFilter && !taskTypesFilter.has(taskType)) continue;
      const key = lastUser.content.slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      eligible.push({ id: r.id, ts: r.ts, model: r.model ?? "(unknown)", messages: msgs, completion: r.completion, servedTokens, taskType });
    }
    if (eligible.length <= limit) return eligible;
    const step = eligible.length / limit;
    const out: LoggedRow[] = [];
    for (let i = 0; i < limit; i++) out.push(eligible[Math.floor(i * step)]!);
    return out;
  } finally {
    db.close();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

interface ResultRow {
  id: number;
  servedModel: string;
  taskType: string;
  score: number;
  wouldEscalate: boolean;
  secondaryError: string | null;
  wallMs: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nIdx = args.indexOf("--n");
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 20;
  if (!Number.isInteger(n) || n <= 0) {
    console.error(
      "usage: gate-chat-replay --n <positive-integer> [--recent <24h|7d|…> | --since <YYYY-MM-DD|ISO>] [--task-types <csv>] [--count-only] [--trend-jsonl <path>]"
    );
    process.exit(1);
  }
  const countOnly = args.includes("--count-only");
  let window: { sinceIso: string | null; label: string };
  let recentArg: string | undefined;
  let sinceArg: string | undefined;
  let trendJsonlPath: string | undefined;
  let taskTypesArg: string | undefined;
  let taskTypesFilter: Set<string> | null;
  try {
    recentArg = readFlag(args, "--recent");
    sinceArg = readFlag(args, "--since");
    trendJsonlPath = readFlag(args, "--trend-jsonl");
    taskTypesArg = readFlag(args, "--task-types");
    window = parseWindow({ recent: recentArg, since: sinceArg });
    taskTypesFilter = parseTaskTypesFilter(taskTypesArg);
  } catch (err) {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  // Short, stable window tag for the trend record (the nightly always runs --recent 24h).
  const windowShort = recentArg ?? (sinceArg ? `since:${window.sinceIso}` : "all-time");

  const cfg = loadConfig();
  const secondary = cfg.disagreementGateModel;
  const threshold = cfg.disagreementGateThreshold;
  const baseUrl = cfg.lmStudioBaseUrl;
  console.error(
    `[setup] secondary=${secondary} threshold=${threshold} endpoint=${baseUrl} (read-only over owner_request_log; no ledger writes, no frontier spend)`
  );
  console.error(`[setup] window=${window.label}`);
  if (taskTypesFilter) console.error(`[setup] task-types filter=${[...taskTypesFilter].join(",")}`);

  if (countOnly) {
    // Zero-inference sizing mode (#201 fix-forward): report the FULL eligible pool for this
    // window/filter, uncapped by --n (a stride-sampled --n would undercount what's actually
    // available). Returns here — nothing below this branch (in particular `chat()`) ever runs.
    const eligible = loadChatRequests(secondary, Number.MAX_SAFE_INTEGER, window.sinceIso, DB_PATH, taskTypesFilter);
    const report = buildCountReport(eligible);
    console.log("\n============ ELIGIBLE ROW COUNT (no model calls) ============");
    console.log(`window ...................... ${window.label}`);
    console.log(`task-types filter ........... ${taskTypesFilter ? [...taskTypesFilter].join(", ") : "(none — all types)"}`);
    console.log(`eligible rows ................ ${report.total}`);
    console.log(`by task type:`);
    for (const { taskType, n: c } of report.byTaskType) {
      console.log(`  ${taskType.padEnd(22)} ${c}`);
    }
    console.log("================================================================");
    return;
  }

  const requests = loadChatRequests(secondary, n, window.sinceIso, DB_PATH, taskTypesFilter);
  const tsSorted = requests.map((r) => r.ts).sort();
  const tsRange = tsSorted.length ? `${tsSorted[0]} … ${tsSorted[tsSorted.length - 1]}` : "(none)";
  console.error(`[setup] sampled ${requests.length} real chat/ask requests with served responses (ts ${tsRange})\n`);
  if (requests.length === 0) {
    console.error("[warn] no eligible requests in the selected window — nothing to replay.");
  }

  const results: ResultRow[] = [];
  const t0 = Date.now();
  for (const [i, r] of requests.entries()) {
    const taskType = r.taskType;
    // Generous budget (2× the served length) so the secondary isn't truncated into phantom
    // disagreement; bounded by SECONDARY_MAX_TOKENS (rows above it were filtered out at load).
    const budget = Math.min(SECONDARY_MAX_TOKENS, Math.max(512, r.servedTokens * 2));

    const w0 = Date.now();
    let row: ResultRow;
    try {
      const secondaryOut = await chat(baseUrl, secondary, toReplayMessages(r.messages), budget);
      const d = gateDecision(r.completion, secondaryOut, threshold);
      row = { id: r.id, servedModel: r.model, taskType, score: d.score, wouldEscalate: d.disagree, secondaryError: null, wallMs: Date.now() - w0 };
    } catch (err) {
      row = { id: r.id, servedModel: r.model, taskType, score: 0, wouldEscalate: false, secondaryError: err instanceof Error ? err.message.slice(0, 80) : String(err), wallMs: Date.now() - w0 };
    }
    results.push(row);
    console.error(
      `[${i + 1}/${requests.length}] #${r.id} ${taskType.padEnd(22)} served=${r.model.padEnd(20)} ` +
        (row.secondaryError ? `ERR=${row.secondaryError}` : `score=${row.score.toFixed(2)} would-escalate=${row.wouldEscalate ? 1 : 0}`) +
        ` (${(row.wallMs / 1000).toFixed(1)}s)`
    );
  }
  const elapsedMs = Date.now() - t0;

  // ── Summary ──
  const ok = results.filter((r) => !r.secondaryError);
  const errs = results.filter((r) => r.secondaryError);
  const wouldEsc = ok.filter((r) => r.wouldEscalate);
  const fireRate = ok.length ? wouldEsc.length / ok.length : 0;
  const scores = ok.map((r) => r.score).sort((a, b) => a - b);
  const byModel = new Map<string, { n: number; esc: number }>();
  const byTaskType = new Map<string, { n: number; esc: number }>();
  for (const r of ok) {
    const e = byModel.get(r.servedModel) ?? { n: 0, esc: 0 };
    e.n++;
    if (r.wouldEscalate) e.esc++;
    byModel.set(r.servedModel, e);

    const t = byTaskType.get(r.taskType) ?? { n: 0, esc: 0 };
    t.n++;
    if (r.wouldEscalate) t.esc++;
    byTaskType.set(r.taskType, t);
  }

  console.log("\n============ GATE OVER REAL CHAT/ASK TRAFFIC (offline) ============");
  console.log(`window .................... ${window.label}  (sampled ts ${tsRange})`);
  console.log(`scored requests ........... ${ok.length}  (${errs.length} secondary-error)`);
  console.log(`WOULD-ESCALATE (disagree).. ${wouldEsc.length} / ${ok.length}  →  fire-rate ${(fireRate * 100).toFixed(1)}%`);
  console.log(`disagreement scores ....... ${scores.length ? scores.map((s) => s.toFixed(2)).join(", ") : "(none)"}`);
  console.log(`by served model:`);
  for (const [m, e] of [...byModel.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${m.padEnd(22)} ${e.esc}/${e.n} disagree`);
  }
  console.log(`by task type:`);
  for (const [t, e] of [...byTaskType.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${t.padEnd(22)} ${e.esc}/${e.n} disagree`);
  }
  if (wouldEsc.length) {
    console.log(`would-escalate task types . ${[...new Set(wouldEsc.map((r) => r.taskType))].join(", ")}`);
  }
  console.log(`avg wall / request ........ ${(ok.reduce((a, r) => a + r.wallMs, 0) / (ok.length || 1) / 1000).toFixed(1)}s`);
  console.log(`total wall ................ ${(elapsedMs / 1000 / 60).toFixed(1)} min`);
  if (ok.length < DEFAULT_MIN_RELIABLE_N) {
    console.log(
      `⚠️  LOW SAMPLE SIZE: n=${ok.length} is below the ${DEFAULT_MIN_RELIABLE_N}-sample reliability floor — ` +
        `the ${(fireRate * 100).toFixed(1)}% fire-rate above is NOT a reliable signal this run (real owner_request_log ` +
        `chat volume in this window was too low). Do not read this as a trend movement.`
    );
  }
  console.log("==================================================================");

  const nowIso = new Date(t0).toISOString();
  // #201: date-stamped so two nights that sample the same n (the nightly always asks for n=60)
  // don't silently overwrite each other's per-request detail — the loss of exactly this evidence
  // (2026-06-27/28/29 and 07-04) was what made the #201 spike hard to diagnose after the fact.
  const outPath = resultsOutputPath(nowIso, results.length);
  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nrows → ${outPath}`);

  // Structured trend spine (one record per run) — the source the Heimdall offloadability
  // panel is built from. Append-only; opt-in via --trend-jsonl so ad-hoc runs don't pollute it.
  if (trendJsonlPath) {
    const record = buildTrendRecord({
      nowIso,
      windowShort,
      okCount: ok.length,
      errCount: errs.length,
      wouldEscalateCount: wouldEsc.length,
      byModel: [...byModel.entries()].sort((a, b) => b[1].n - a[1].n).map(([model, e]) => ({ model, n: e.n, esc: e.esc })),
      byTaskType: [...byTaskType.entries()].sort((a, b) => b[1].n - a[1].n).map(([taskType, e]) => ({ taskType, n: e.n, esc: e.esc })),
      taskTypesFilter: taskTypesFilter ? [...taskTypesFilter] : undefined,
      sampledTsSorted: tsSorted,
    });
    appendFileSync(trendJsonlPath, JSON.stringify(record) + "\n");
    console.log(`trend → ${trendJsonlPath} (${record.date} fire-rate ${record.fireRatePct}%)`);
  }
}

// Run only when invoked as a script — importing for unit tests must NOT start a replay
// (it would open the DB and hit the network). pure parseWindow/parseDurationMs stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
