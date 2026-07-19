/**
 * harvest-verdicts.ts — turn REAL delegation traffic into REAL capability evidence.
 *
 * Forks the read-only `gate-chat-replay` worker into one that WRITES verdicts. For each real
 * (prompt, answer) pair in owner_request_log it runs a CALIBRATED local judge (default
 * HARVEST_JUDGE_DEFAULT — see harvest.ts for the model choice + calibration; validate with
 * `scripts/judge-calibrate.ts` against tests/fixtures/judge-control.jsonl) and records a genuine
 * pass/partial/fail into the capability ledger — closing the loop the audit found open: today the
 * Claude→M5 `mcp-ask` channel records everything `unverified`, so real usage never moves routing.
 *
 * The judge call sends response_format {json_object} by default (--no-response-format to disable):
 * grammar-constrained decoding structurally prevents the gpt-oss harmony 500 (#166) rather than
 * only retrying it, so gpt-oss-120b can serve as a reliable judge covering every model.
 *
 * Everything is local (owner's own consented content, judged on-box — nothing leaves the machine)
 * and free (local compute). Safety mirrors the disagreement gate:
 *   --mode shadow  (DEFAULT): writes rows as `unverified` (invisible to getVerdict — ZERO routing
 *                  impact) with the judge's intended verdict in `notes`. Use this to CALIBRATE the
 *                  judge against real traffic before trusting it.
 *   --mode on      : writes the real outcome + verifier `llm-judge:<model>`. Counts toward the
 *                  verdict for non-judgment types immediately; a judgment-quality type (code-review)
 *                  still requires `llm-judge:<model>` in HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS (#168).
 *   --dry-run      : compute + print, write NO LEDGER ROWS. Always start here. (A --write-jsonl
 *                  artifact, if given, is still emitted — it is an explicit inspection output, not
 *                  a ledger write.)
 *
 * Wrap in the GPU lease so the judge swaps don't thrash the serial GPU; safe to schedule nightly:
 *   cd /srv/gille-inference
 *   npx tsx src/homeserver/cli.ts gpu run --model harvest --eta 30m --purpose harvest \
 *     -- npx tsx scripts/harvest-verdicts.ts --mode shadow --n 40 --recent 24h
 *
 * Every verdict is stamped with the grading-policy epoch (#217, HARVEST_JUDGE_POLICY in
 * harvest.ts + the row's effective context budget). NULL judge_policy = the pre-2026-07-11
 * cohort (context-blind / tool-coerced / parts-dropped epochs) — mechanically excludable.
 * After a policy bump, run once with --rejudge-existing: rows whose only live verdicts are
 * stale-epoch get regraded, their old rows marked superseded_at (supersede-not-duplicate —
 * evidence readers filter superseded rows; the audit trail stays).
 *
 * Flags: --mode shadow|on  --n <int>  --recent <24h|7d|…>  --since <YYYY-MM-DD|ISO>
 *        --judge-model <id>  --no-response-format  --rejudge-existing  --dry-run
 *        --write-jsonl <path>
 * Env:   HARVEST_JUDGE_MAX_TOKENS (default 4000 — the judge is a REASONING model; 600 starved it,
 *        see HARVEST_JUDGE_MAX_TOKENS_DEFAULT in harvest.ts; a starved call auto-retries doubled)
 *        HARVEST_JUDGE_CONTEXT_CHARS (default 24000 — #197: multi-turn rows send the judge a
 *        bounded transcript of the conversation's OTHER turns (since #216 incl. the assistant's
 *        post-ask tool activity) so it stops failing answers for referencing a conversation it
 *        couldn't see; 0 restores the last-turn-only judge)
 *        HARVEST_JUDGE_CTX_WINDOW (default 65536 — the judge model's serving window in tokens;
 *        context shrinks to fit, escalation is capped, and a row whose mandatory input alone
 *        exceeds the window is SKIPPED pre-HTTP with an input-too-large count)
 *        HARVEST_JUDGE_CHARS_PER_TOKEN (default 3.5 — input-size estimate; lower toward 1.5-2
 *        for CJK-heavy traffic, where 3.5 materially over-budgets)
 *        HARVEST_CALL_TIMEOUT_MS (default 600000)
 *        HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES (default "other" — broad catch-all rows never
 *        write verdicts in --mode on; shadow grades everything; set "" to disable)
 */
import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadChatRequests, readFlag, parseWindow } from "./gate-chat-replay.js";
import { classifyTask } from "../src/homeserver/taxonomy.js";
import { loadConfig } from "../src/homeserver/config.js";
import {
  importDelegations,
  supersedeHarvestVerdicts,
  ensureLedgerSchema,
  type ImportableDelegation,
} from "../src/homeserver/ledger.js";
import {
  buildJudgePrompt,
  buildJudgeBody,
  buildJudgeContext,
  splitTaskFromMessages,
  parseJudgeVerdict,
  classifyJudgeCompletion,
  escalateJudgeMaxTokens,
  capJudgeMaxTokens,
  planJudgeInput,
  hasRealHistory,
  JUDGE_PROMPT_TEMPLATE_ALLOWANCE,
  HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT,
  shouldWriteVerdict,
  harvestRecord,
  canonicalModelId,
  isSelfGrade,
  isCurrentPolicy,
  buildJudgePolicyStamp,
  HARVEST_JUDGE_POLICY,
  HARVEST_JUDGE_DEFAULT,
  HARVEST_JUDGE_MAX_TOKENS_DEFAULT,
  HARVEST_JUDGE_CONTEXT_CHARS_DEFAULT,
  type HarvestMode,
  type JudgeChatResponse,
} from "../src/homeserver/harvest.js";

const CALL_TIMEOUT_MS = Number(process.env["HARVEST_CALL_TIMEOUT_MS"] ?? 600_000);
const DB_PATH = process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
// Judge token budget. The 600 default starved gpt-oss-120b's reasoning channel on real traffic
// (the 2026-07-08/09 "empty judge completion" judge-errs — see HARVEST_JUDGE_MAX_TOKENS_DEFAULT
// in harvest.ts for the measured evidence). Env override for experiments; a starved call is
// retried with a DOUBLED budget regardless (escalateJudgeMaxTokens).
const JUDGE_MAX_TOKENS = (() => {
  const n = Number(process.env["HARVEST_JUDGE_MAX_TOKENS"] ?? HARVEST_JUDGE_MAX_TOKENS_DEFAULT);
  return Number.isFinite(n) && n > 0 ? n : HARVEST_JUDGE_MAX_TOKENS_DEFAULT;
})();
// #197: char budget for the conversation-context transcript the judge sees on multi-turn rows
// (the judge used to grade ONLY the last user turn — multi-turn/agentic rows falsely failed on
// context it couldn't see). 0 disables context entirely (the pre-#197 behavior).
const JUDGE_CONTEXT_CHARS = (() => {
  const raw = process.env["HARVEST_JUDGE_CONTEXT_CHARS"];
  if (raw === undefined) return HARVEST_JUDGE_CONTEXT_CHARS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : HARVEST_JUDGE_CONTEXT_CHARS_DEFAULT;
})();
// Serving window of the judge model in tokens (llama-swap runs gpt-oss-120b at -c 65536). Used to
// cap starvation escalation so input + completion always fits (agy review). Override if the box
// config changes: HARVEST_JUDGE_CTX_WINDOW.
const JUDGE_CTX_WINDOW = (() => {
  const n = Number(process.env["HARVEST_JUDGE_CTX_WINDOW"] ?? HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT);
  return Number.isFinite(n) && n > 0 ? n : HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT;
})();
// Chars-per-token estimate for input sizing. 3.5 is prose-calibrated; CJK runs ~1-2 chars/token,
// so lower this (HARVEST_JUDGE_CHARS_PER_TOKEN=2) if the box grades bilingual traffic (codex retro).
const JUDGE_CHARS_PER_TOKEN_EST = (() => {
  const raw = process.env["HARVEST_JUDGE_CHARS_PER_TOKEN"];
  if (raw === undefined) return undefined; // let the library default apply
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Source-request-level idempotency, policy-aware since #217: one LIVE harvested verdict per
 * (owner_request_log row, mode). The judge is not perfectly deterministic at temp 0, so its
 * score/reason can vary between runs — and importDelegations' content-hash id includes those, so
 * a naive re-run would insert a SECOND verdict for the same real request and double-count it as
 * two attempts in verdict math. Ids are keyed on the `#<id>` stamped into `notes`; superseded
 * rows are invisible (an id whose only verdicts are superseded is FREE to grade — that is what
 * makes the supersede-first rejudge ordering crash-safe). Classification:
 *   `current` — has a live verdict under the CURRENT grading policy (always skipped)
 *   `stale`   — has live verdict(s) only under an older/NULL policy (skipped by default;
 *               regraded by --rejudge-existing, which supersedes the old rows first)
 */
export function loadHarvestPolicyState(
  sourceTag: string,
  dbPath = DB_PATH
): { current: Set<number>; stale: Set<number> } {
  const current = new Set<number>();
  const stale = new Set<number>();
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    // DB file doesn't exist yet (fresh box) → nothing harvested; importDelegations creates it later.
    return { current, stale };
  }
  try {
    // Pre-#217 DBs have neither column: every harvested row is then pre-epoch (stale) and none
    // can be superseded — exactly what querying with constant fallbacks expresses.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(delegations)`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    const policyExpr = cols.has("judge_policy") ? "judge_policy" : "NULL";
    const liveExpr = cols.has("superseded_at") ? "superseded_at IS NULL" : "1=1";
    const rows = db
      .prepare(
        `SELECT notes, ${policyExpr} AS judge_policy FROM delegations
         WHERE source = ? AND notes LIKE '%#%' AND ${liveExpr}`
      )
      .all(sourceTag) as { notes: string | null; judge_policy: string | null }[];
    for (const r of rows) {
      const m = r.notes?.match(/#(\d+)/);
      if (!m) continue;
      const id = Number(m[1]);
      if (isCurrentPolicy(r.judge_policy)) {
        current.add(id);
        stale.delete(id); // current wins over any older live row for the same id
      } else if (!current.has(id)) {
        stale.add(id);
      }
    }
    return { current, stale };
  } catch (err) {
    // A missing `delegations` table on an existing DB is benign (nothing harvested yet). But ANY
    // OTHER error (locked / corrupt / IO) must NOT silently return an empty set — that would disable
    // the idempotency guard and let a re-run double-count real requests. Abort loudly instead.
    if (/no such table/i.test(String(err))) return { current, stale };
    throw new Error(
      `loadHarvestPolicyState: unexpected DB error — aborting to preserve idempotency: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    db?.close();
  }
}

/** Back-compat view of the idempotency set: every id with ANY live verdict (current ∪ stale). */
export function loadHarvestedSourceIds(sourceTag: string, dbPath = DB_PATH): Set<number> {
  const { current, stale } = loadHarvestPolicyState(sourceTag, dbPath);
  return new Set([...current, ...stale]);
}

/**
 * Which sampled rows this run processes (codex review of #226): under --rejudge-existing the
 * loader is called UNCAPPED and rows with a current-policy verdict are excluded BEFORE the --n
 * cap — otherwise the cap lands on the generic newest-first sample, deterministically reselects
 * the same (already current) rows every run, and a stale cohort larger than --n can never be
 * drained. Without the flag the loader's own cap already applied; rows pass through untouched.
 */
export function selectRowsForRun<T extends { id: number }>(
  rows: readonly T[],
  currentIds: ReadonlySet<number>,
  rejudgeExisting: boolean,
  n: number
): T[] {
  if (!rejudgeExisting) return [...rows];
  return rows.filter((r) => !currentIds.has(r.id)).slice(0, n);
}

export type RowAction =
  | "skip-current"
  | "skip-stale-policy"
  | "skip-excluded-type"
  | "retire-excluded-type"
  | "grade"
  | "grade-rejudge";

/**
 * The harvest loop's per-row decision, pure (codex review of #226). One rule needs calling out:
 * a STALE row whose task type is now excluded from verdict writing (`writeVerdict === false`)
 * is RETIRED under --rejudge-existing — its old verdict is superseded with NO replacement.
 * Skipping it (the naive behavior) would leave a mode=on verdict for a type that current policy
 * says must never teach routing live forever, un-retirable by the very flag built to fix epochs.
 */
export function planRowAction(p: {
  inCurrent: boolean;
  inStale: boolean;
  rejudgeExisting: boolean;
  /** shouldWriteVerdict(taskType, mode, excludedTaskTypes) for this row. */
  writeVerdict: boolean;
}): RowAction {
  if (p.inCurrent) return "skip-current";
  if (p.inStale && !p.rejudgeExisting) return "skip-stale-policy";
  if (!p.writeVerdict) return p.inStale && p.rejudgeExisting ? "retire-excluded-type" : "skip-excluded-type";
  return p.inStale && p.rejudgeExisting ? "grade-rejudge" : "grade";
}

/**
 * Transient errors worth retrying AT THE SAME BUDGET: swap-in-progress 503s, network blips, empty
 * completions, and — as a backstop — any residual HTTP 5xx. The judge sends response_format
 * {json_object} by default (grammar-constrained decode), which STRUCTURALLY prevents the gpt-oss
 * harmony/PEG format-500 that used to hit ~1/3 of requests (#166); `--no-response-format`
 * re-exposes the raw flakiness for the reliability experiment. TOKEN STARVATION is handled
 * separately (JudgeStarvedError → retry with a DOUBLED budget): same-budget retries can never
 * recover it because reasoning length at temp 0 is near-deterministic — the exact trap the
 * 2026-07-08/09 nightlies fell into. A judge error is NOT recorded as model evidence — retrying
 * just keeps the sample yield high.
 */
function isTransientJudgeError(msg: string): boolean {
  return /HTTP 5\d\d|HTTP 429|empty judge|aborted|ECONNRESET|fetch failed|network/i.test(msg);
}

/** Starvation (finish_reason "length", no usable verdict) — retryable ONLY with a bigger budget. */
export class JudgeStarvedError extends Error {}

/** Judge response_format: {type:"json_object"} (default, grammar-constrained) or null (unconstrained). */
type JudgeResponseFormat = { type: "json_object" } | null | undefined;

async function judgeOnce(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  responseFormat: JudgeResponseFormat,
  maxTokens: number
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify(buildJudgeBody(model, system, user, { responseFormat, maxTokens })),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const data = (await resp.json()) as JudgeChatResponse;
    const out = classifyJudgeCompletion(data);
    if (out.kind === "starved") throw new JudgeStarvedError(`judge starved (max_tokens=${maxTokens}): ${out.detail}`);
    if (out.kind === "empty") throw new Error("empty judge completion");
    return out.content;
  } finally {
    clearTimeout(timer);
  }
}

/** Yield stats surfaced in the run summary — how often the budget escalation actually fired. */
export const judgeRetryStats = { starvedEscalations: 0 };

/**
 * The retry loop, with the one call injectable so the starved/transient interplay is unit-testable
 * (tests/harvest-judge-reliability.test.ts):
 *   - starved   → retry ONLY if escalateJudgeMaxTokens yields a strictly BIGGER budget; at/above
 *                 the cap it fails fast instead of re-running a deterministic starvation (and an
 *                 operator's above-cap override is never lowered).
 *   - transient → retry at the SAME budget after a short sleep (swap 503s, network blips).
 *   - anything else → throw immediately.
 */
export async function judgeWithRetry(
  callOnce: (maxTokens: number) => Promise<string>,
  opts?: {
    retries?: number;
    initialMaxTokens?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Judge INPUT size (system + user chars). When given, every attempt's budget is capped so
     *  input + completion fits the serving window — an uncapped escalation to 16k tokens can
     *  overflow long multi-turn rows when the configured context transcript is raised (agy review). */
    inputChars?: number;
    ctxWindowTokens?: number;
    charsPerToken?: number;
  }
): Promise<string> {
  const retries = opts?.retries ?? 3;
  const sleepFn = opts?.sleep ?? sleep;
  const cap = (mt: number): number =>
    opts?.inputChars === undefined
      ? mt
      : capJudgeMaxTokens(mt, opts.inputChars, opts.ctxWindowTokens ?? HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT, opts.charsPerToken);
  let maxTokens = opts?.initialMaxTokens ?? JUDGE_MAX_TOKENS;
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callOnce(cap(maxTokens));
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt < retries && err instanceof JudgeStarvedError) {
        const next = escalateJudgeMaxTokens(maxTokens);
        if (next > maxTokens && cap(next) > cap(maxTokens)) {
          // Same effective budget ⇒ same starvation. Double it (cap- and window-bounded) and retry.
          maxTokens = next;
          judgeRetryStats.starvedEscalations++;
          continue;
        }
        throw new Error(lastErr); // escalation exhausted — a same-budget retry cannot recover
      }
      if (attempt < retries && isTransientJudgeError(lastErr)) {
        await sleepFn(2500);
        continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr);
}

function judge(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  responseFormat: JudgeResponseFormat
): Promise<string> {
  return judgeWithRetry((maxTokens) => judgeOnce(baseUrl, model, system, user, responseFormat, maxTokens), {
    inputChars: system.length + user.length,
    ctxWindowTokens: JUDGE_CTX_WINDOW,
    charsPerToken: JUDGE_CHARS_PER_TOKEN_EST,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nIdx = args.indexOf("--n");
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 20;
  if (!Number.isInteger(n) || n <= 0) {
    console.error("usage: harvest-verdicts --mode shadow|on --n <int> [--recent 24h|--since …] [--judge-model id] [--no-response-format] [--rejudge-existing] [--dry-run] [--write-jsonl path]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  // #217: regrade rows whose only live verdicts were graded under an OLDER policy epoch. The old
  // rows are superseded FIRST (audit-preserving, crash-safe: a crash between supersede and import
  // leaves the id verdict-less, which the next run simply regrades), then the new verdicts import
  // under the current HARVEST_JUDGE_POLICY stamp. Never part of the nightly — run manually after
  // a policy bump.
  const rejudgeExisting = args.includes("--rejudge-existing");
  // response_format {json_object} is ON by default (grammar-constrained decode — structurally
  // prevents the gpt-oss harmony 500, #166). --no-response-format sends an unconstrained call.
  const responseFormat: JudgeResponseFormat = args.includes("--no-response-format") ? null : undefined;
  let mode: HarvestMode = "shadow";
  let recentArg: string | undefined;
  let sinceArg: string | undefined;
  let judgeModel = HARVEST_JUDGE_DEFAULT;
  let jsonlPath: string | undefined;
  let window: { sinceIso: string | null; label: string };
  try {
    const modeArg = readFlag(args, "--mode");
    if (modeArg !== undefined) {
      if (modeArg !== "shadow" && modeArg !== "on") throw new Error(`--mode: expected shadow|on, got ${JSON.stringify(modeArg)}`);
      mode = modeArg;
    }
    recentArg = readFlag(args, "--recent");
    sinceArg = readFlag(args, "--since");
    jsonlPath = readFlag(args, "--write-jsonl");
    const jm = readFlag(args, "--judge-model");
    if (jm !== undefined) judgeModel = jm;
    window = parseWindow({ recent: recentArg, since: sinceArg });
  } catch (err) {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const baseUrl = cfg.lmStudioBaseUrl;
  const excludedTaskTypes = cfg.harvestExcludedTaskTypes;
  console.error(
    `[setup] mode=${mode}${dryRun ? " (DRY-RUN — no writes)" : ""} judge=${judgeModel} ` +
      `json_format=${responseFormat === null ? "off" : "on"} judge_max_tokens=${JUDGE_MAX_TOKENS} ` +
      `judge_context_chars=${JUDGE_CONTEXT_CHARS} judge_ctx_window=${JUDGE_CTX_WINDOW}` +
      `${JUDGE_CHARS_PER_TOKEN_EST !== undefined ? ` chars_per_token=${JUDGE_CHARS_PER_TOKEN_EST}` : ""} endpoint=${baseUrl}`
  );
  if (mode === "on" && excludedTaskTypes.length > 0) {
    console.error(
      `[setup] excluded task types (never write verdicts in mode=on): ${excludedTaskTypes.join(", ")} ` +
        `(HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES)`
    );
  }
  console.error(`[setup] window=${window.label}`);
  if (mode === "on" && !dryRun) {
    console.error(
      "[setup] ⚠️  mode=on writes REAL verdicts. Non-judgment task types will affect routing immediately; " +
        "judgment-quality types (code-review) still need llm-judge in HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS."
    );
  }

  // Pass the judge model as the "self" model so rows it served are skipped (no self-grading).
  // Under --rejudge-existing the loader runs UNCAPPED and the --n cap is applied AFTER excluding
  // current-policy rows (selectRowsForRun) — capping the generic newest-first sample would
  // deterministically reselect the same already-current rows and never drain a stale cohort
  // larger than --n (codex review of #226).
  const sampled = loadChatRequests(judgeModel, rejudgeExisting ? Number.MAX_SAFE_INTEGER : n, window.sinceIso);
  const sourceTag = mode === "shadow" ? "harvest-shadow" : "harvest";
  // Migrate first (adds judge_policy/superseded_at on a pre-#217 DB) so the policy-state read
  // below sees the real columns. Dry-run stays write-free (no migration; the state loader is
  // PRAGMA-guarded), and a plain --dry-run still bypasses the idempotency set entirely — but
  // --dry-run --rejudge-existing loads the REAL state so it previews the actual rejudge
  // selection instead of grading a generic sample and reporting "rejudged 0" (codex review).
  if (!dryRun) ensureLedgerSchema();
  const policyState =
    dryRun && !rejudgeExisting
      ? { current: new Set<number>(), stale: new Set<number>() }
      : loadHarvestPolicyState(sourceTag);
  const rows = selectRowsForRun(sampled, policyState.current, rejudgeExisting, n);
  console.error(
    `[setup] sampled ${rows.length} real requests with served responses` +
      (rejudgeExisting ? ` (from an uncapped pool of ${sampled.length}, current-policy rows excluded pre-cap)` : "") +
      (policyState.current.size + policyState.stale.size
        ? ` (${policyState.current.size + policyState.stale.size} already harvested in ${sourceTag}` +
          (policyState.stale.size
            ? `, ${policyState.stale.size} under a stale policy — ${
                rejudgeExisting ? "REJUDGING those" : "run --rejudge-existing to supersede+regrade"
              }`
            : "") +
          ` — current policy ${HARVEST_JUDGE_POLICY})`
        : "") +
      "\n"
  );

  const records: ImportableDelegation[] = [];
  const rejudgedIds: number[] = [];
  const retiredIds: number[] = [];
  let judgeErrors = 0;
  let parseFails = 0;
  let skippedExisting = 0;
  let skippedStalePolicy = 0;
  let skippedSelfGrade = 0;
  let skippedExcludedType = 0;
  // #197 + codex retro: honest context stats — graded-with-context (post-parse, not attempts),
  // real conversational history (a bare system prefix is context but not history), and rows
  // skipped pre-HTTP because the mandatory input alone cannot fit the judge's window.
  let contextGraded = 0;
  let realHistoryGraded = 0;
  let inputTooLarge = 0;
  const tally = new Map<string, { pass: number; partial: number; fail: number }>();

  for (const [i, r] of rows.entries()) {
    // Defence-in-depth over loadChatRequests' exact-string self-skip: compare CANONICALLY so a row
    // served under a raw gguf filename can't be graded by the same model under its alias.
    if (isSelfGrade(r.model, judgeModel)) {
      skippedSelfGrade++;
      continue;
    }
    // #197: the other turns become a BOUNDED transcript so the judge can finally see the
    // conversation it is grading; #216: task = last GENUINE user turn (tool results no longer
    // pose as it), and the transcript includes the assistant's post-ask tool loop.
    // Single-turn rows get context "" → the exact historical prompt.
    const { task: lastUser, prior } = splitTaskFromMessages(r.messages);
    const taskType = classifyTask(lastUser).taskType;
    // One decision point (planRowAction, pure + table-tested): idempotency (one LIVE verdict per
    // source request), stale-policy handling, and the excluded-type rule — the broad catch-all
    // bucket must never TEACH routing in mode=on (shadow still grades everything), and a STALE
    // excluded-type verdict is RETIRED under --rejudge-existing (superseded, no replacement).
    const action = planRowAction({
      inCurrent: policyState.current.has(r.id),
      inStale: policyState.stale.has(r.id),
      rejudgeExisting,
      writeVerdict: shouldWriteVerdict(taskType, mode, excludedTaskTypes),
    });
    if (action === "skip-current") {
      skippedExisting++;
      continue;
    }
    if (action === "skip-stale-policy") {
      skippedStalePolicy++;
      continue;
    }
    if (action === "skip-excluded-type") {
      skippedExcludedType++;
      console.error(
        `[${i + 1}/${rows.length}] #${r.id} ${taskType.padEnd(16)} served=${canonicalModelId(r.model).padEnd(22)} → EXCLUDED-TYPE (no verdict in mode=on)`
      );
      continue;
    }
    if (action === "retire-excluded-type") {
      retiredIds.push(r.id);
      console.error(
        `[${i + 1}/${rows.length}] #${r.id} ${taskType.padEnd(16)} served=${canonicalModelId(r.model).padEnd(22)} → RETIRE (stale verdict for an excluded type — superseding without replacement)`
      );
      continue;
    }
    const isRejudge = action === "grade-rejudge";
    const model = canonicalModelId(r.model);
    // Pre-flight sizing (codex retro): skip un-gradeable rows BEFORE HTTP (a doomed call would
    // surface as judge-err and silently bias evidence against long rows); the optional context
    // absorbs the squeeze when the window is tight.
    const plan = planJudgeInput({
      fixedChars: lastUser.length + r.completion.length + JUDGE_PROMPT_TEMPLATE_ALLOWANCE,
      requestedContextChars: JUDGE_CONTEXT_CHARS,
      ctxWindowTokens: JUDGE_CTX_WINDOW,
      charsPerToken: JUDGE_CHARS_PER_TOKEN_EST,
    });
    if (plan.skip) {
      inputTooLarge++;
      console.error(
        `[${i + 1}/${rows.length}] #${r.id} ${taskType.padEnd(16)} served=${model.padEnd(22)} → SKIP ${plan.reason}`
      );
      continue;
    }
    const context = plan.contextChars > 0 ? buildJudgeContext(prior, plan.contextChars) : "";
    const { system, user } = buildJudgePrompt(taskType, lastUser, r.completion, context || undefined);

    let verdictStr = "SKIP";
    try {
      const out = await judge(baseUrl, judgeModel, system, user, responseFormat);
      const v = parseJudgeVerdict(out);
      if (!v) {
        parseFails++;
      } else {
        verdictStr = `${v.verdict} (${v.score.toFixed(2)})`;
        if (context) {
          contextGraded++;
          if (hasRealHistory(prior)) realHistoryGraded++;
        }
        const rec = harvestRecord({
          row: r,
          taskType,
          prompt: lastUser,
          judge: v,
          judgeModel,
          mode,
          judgePolicy: buildJudgePolicyStamp(plan.contextChars),
        });
        records.push(rec);
        if (isRejudge) rejudgedIds.push(r.id);
        const key = `${taskType}\t${model}`;
        const t = tally.get(key) ?? { pass: 0, partial: 0, fail: 0 };
        t[v.verdict]++;
        tally.set(key, t);
      }
    } catch (err) {
      judgeErrors++;
      verdictStr = `JUDGE-ERR ${err instanceof Error ? err.message.slice(0, 50) : ""}`;
    }
    console.error(`[${i + 1}/${rows.length}] #${r.id} ${taskType.padEnd(16)} served=${model.padEnd(22)} → ${verdictStr}`);
  }

  // ── Write (unless dry-run) ──
  let inserted = 0;
  let skipped = 0;
  let superseded = 0;
  if (!dryRun) {
    // Supersede BEFORE import (#217): a crash in between leaves the rejudged ids verdict-less —
    // the next --rejudge-existing run regrades them. The reverse order would leave two LIVE
    // verdicts for the same request (double-counted attempts) until someone noticed. Retired ids
    // (stale verdicts for now-excluded types) are superseded with NO replacement — a retire-only
    // run therefore supersedes even when zero new records were graded.
    const toSupersede = [...rejudgedIds, ...retiredIds];
    if (toSupersede.length > 0) {
      superseded = supersedeHarvestVerdicts({
        sourceTag,
        sourceRowIds: toSupersede,
        nowIso: new Date().toISOString(),
      });
    }
    if (records.length > 0) {
      const res = importDelegations(records);
      inserted = res.inserted;
      skipped = res.skipped;
    }
  }

  if (jsonlPath) {
    for (const rec of records) appendFileSync(jsonlPath, JSON.stringify(rec) + "\n");
  }

  // ── Summary ──
  console.log("\n============ HARVEST: real traffic → capability evidence ============");
  console.log(`mode ...................... ${mode}${dryRun ? "  (DRY-RUN — nothing written)" : ""}`);
  console.log(`judge ..................... ${judgeModel}`);
  console.log(
    `sampled / graded .......... ${rows.length} / ${records.length}  (already-harvested ${skippedExisting}, ` +
      `self-grade ${skippedSelfGrade}, excluded-type ${skippedExcludedType}, judge-err ${judgeErrors}, ` +
      `parse-fail ${parseFails}, starved-retries ${judgeRetryStats.starvedEscalations}, ` +
      `input-too-large ${inputTooLarge}, stale-policy ${skippedStalePolicy}, rejudged ${rejudgedIds.length}, ` +
      `retired-excluded ${retiredIds.length}, with-context ${contextGraded} [real-history ${realHistoryGraded}])`
  );
  console.log(`per (task_type, model) verdicts:`);
  for (const [key, t] of [...tally.entries()].sort()) {
    const [tt, m] = key.split("\t");
    const total = t.pass + t.partial + t.fail;
    const rate = total ? ((t.pass + 0.5 * t.partial) / total).toFixed(2) : "—";
    console.log(`  ${tt.padEnd(16)} ${m.padEnd(22)} pass=${t.pass} partial=${t.partial} fail=${t.fail}  rate=${rate}`);
  }
  if (!dryRun) {
    console.log(
      `ledger writes ............. inserted=${inserted} skipped(dupe)=${skipped}` +
        (superseded > 0 ? ` superseded=${superseded}` : "")
    );
  }
  if (skippedStalePolicy > 0 && !rejudgeExisting) {
    console.log(
      `NOTE: ${skippedStalePolicy} row(s) carry verdicts from an older grading policy (current: ${HARVEST_JUDGE_POLICY}).`
    );
    console.log(`      Run with --rejudge-existing to supersede and regrade them.`);
  }
  if (mode === "shadow") {
    console.log(`NOTE: shadow rows are outcome='unverified' — they do NOT affect routing. Inspect them, then`);
    console.log(`      re-run --mode on when the judge looks trustworthy on your real traffic.`);
  }
  console.log("====================================================================");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
