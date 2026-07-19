import type { ImportableDelegation, Outcome } from "./ledger.js";

/**
 * Harvest — turn REAL delegation traffic into REAL capability evidence.
 *
 * The capability ledger only ever learned from a fixed synthetic probe battery: the one channel
 * the whole project exists to measure — Claude Code delegating sub-tasks to the box (`mcp-ask`) —
 * records every row as `outcome: "unverified"` (there is no verifier on the passthrough), and
 * `getVerdict()` filters `unverified` out. So thousands of real delegations could succeed and the
 * routing table would be no wiser. This module closes that loop: it takes a real (prompt, answer)
 * pair from `owner_request_log` (owner's own consented content, judged locally — nothing leaves the
 * box) and grades it with a CALIBRATED local judge, producing a genuine pass/partial/fail row.
 *
 * Safety is worker-level and mirrors the disagreement gate's `off|shadow|on`:
 *   - shadow: write the row as `outcome: "unverified"` (so `getVerdict` ignores it — ZERO routing
 *     impact) with the judge's INTENDED verdict encoded in `notes`. This yields the data to evaluate
 *     the judge on real traffic before trusting it.
 *   - on: write the row with the real outcome + `verifier: "llm-judge:<model>"`. For a NON-judgment
 *     task type this counts toward the verdict immediately; for a judgment-quality type (code-review)
 *     it only counts once `llm-judge:<model>` is added to `policy.trustedVerifiersForJudgment` (#168),
 *     so trust is still an explicit, reversible config flip — never automatic.
 *
 * The judge is reference-free (it grades "does this answer accomplish the task", not "does it match a
 * gold") — a genuine but imperfect signal. It is deliberately conservative (uncertainty → `partial`,
 * never a false `pass`), and its verdicts are gated by shadow-mode + the whitelist above precisely
 * because a local model grading local output has correlated-error risk. Calibrate before flipping on.
 */

export type HarvestMode = "shadow" | "on";

/**
 * Default judge: gpt-oss-120b. The judge call now sends response_format {json_object} (buildJudgeBody),
 * which engages llama.cpp grammar-constrained decoding and STRUCTURALLY eliminates the harmony
 * non-streaming 500 that previously made gpt-oss unusable as a judge (#166 / ggml-org/llama.cpp#25321).
 * Measured on the labeled control (docs/harvest-judge-calibration-2026-07-06.md; reproduce with
 * scripts/judge-calibrate.ts): response_format OFF → gpt-oss errored on 64% of calls; ON → 0% errors,
 * 22/22 graded, FAIL-SAFETY 1.0 (never passed a known-bad answer, incl. every adversarial trap).
 * Chosen over qwen3-coder-next-80b because it (a) serves almost no real traffic, so the no-self-grading
 * skip costs ~nothing and it can grade EVERY model — including qwen-coder's OWN rows, the coverage
 * blind spot under the old default — and (b) is a far better code-review judge (#158: ~82% vs ~23% bug
 * recall). qwen-coder edges it on 3-way accuracy by one example (0.91 vs 0.86), but that gap is fuzzy
 * partial-boundary, not a safety miss. Switch back any time: `--judge-model qwen3-coder-next-80b`
 * (or HARVEST_JUDGE=… in the cron). Calibrate before flipping HARVEST_MODE=on.
 */
export const HARVEST_JUDGE_DEFAULT = "gpt-oss-120b";

export interface JudgeVerdict {
  verdict: "pass" | "partial" | "fail";
  /** Judge's confidence/quality score in [0,1]. */
  score: number;
  /** Short free-text rationale (already length-capped by the parser). */
  reason: string;
}

// ─── Model-identity canonicalization ─────────────────────────────────────────────
//
// Bug the audit surfaced: deep-research wrote 496 ledger rows (~32% of the ledger) under RAW GGUF
// filenames (`Mellum2-12B-…gguf`, `Qwen3-Coder-Next-…gguf`) while every other path uses the served
// ALIAS (`mellum`, `qwen3-coder-next-80b`). A query keyed on the alias silently misses that evidence.
// Harvested evidence MUST land under the same identity as probe evidence or it can't aggregate, so we
// canonicalize here. Conservative: only the two documented raw-filename families are mapped; anything
// already-aliased (or unknown) passes through untouched — we never guess a mapping.

const CANONICAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/mellum/i, "mellum"],
  [/qwen3-?coder-?next/i, "qwen3-coder-next-80b"],
];

export function canonicalModelId(model: string | null | undefined): string {
  const raw = (model ?? "").trim();
  if (!raw) return "(unknown)";
  // Only remap something that looks like a raw filename (has a .gguf or path/underscore shape);
  // a clean alias like "qwen3-30b-instruct" must never be clobbered by a loose substring hit.
  const looksRaw = /\.gguf$|_|\//i.test(raw);
  if (looksRaw) {
    for (const [re, canon] of CANONICAL_PATTERNS) if (re.test(raw)) return canon;
  }
  return raw;
}

/**
 * True if the served model and the judge are the same underlying model — compared CANONICALLY so a
 * raw gguf-filename served id (e.g. `Qwen3-Coder-Next-…gguf`) can't slip past a plain exact-string
 * self-grade skip and let the judge grade its own output. Harvested evidence is written under the
 * canonical id, so the self-grade check must be canonical too, or the no-self-grading safety boundary
 * has a gap exactly on the raw-filename inputs `canonicalModelId` exists to normalize.
 */
export function isSelfGrade(servedModel: string | null | undefined, judgeModel: string): boolean {
  return canonicalModelId(servedModel) === canonicalModelId(judgeModel);
}

// ─── Judge prompt ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM =
  "You are a STRICT, calibrated grader of an AI assistant's answer. You are given the TASK the user " +
  "asked and the ASSISTANT'S ANSWER. Judge whether the answer correctly and completely accomplishes " +
  "the task. Grade conservatively: 'pass' = correct and complete; 'partial' = mostly correct but with " +
  "a real omission or minor error; 'fail' = wrong, incomplete, off-topic, a refusal, or you cannot " +
  "confirm it is correct. If the task needs external facts you are not confident about, do NOT guess " +
  "'pass' — use 'partial' and say why. Output ONLY compact JSON: " +
  '{"verdict":"pass"|"partial"|"fail","score":0.0-1.0,"reason":"<=15 words"}.';

/** Task-type-specific grading hint (keyed by prefix; longest match wins). Reference-free. */
const TYPE_HINTS: ReadonlyArray<[string, string]> = [
  ["code-review", "For a review: it must correctly identify the real defect, not a spurious one."],
  ["code", "For code: it must be correct and runnable for the stated contract, not just plausible."],
  ["unit-test", "For tests: they must actually exercise the contract and be correct."],
  ["sql", "For SQL: it must correctly answer the question against the described schema."],
  ["summarize", "For a summary: it must be faithful (no invented or contradicted facts) and cover the key point."],
  ["extract", "It must be exactly the requested value, with nothing extra."],
  ["classify", "It must be exactly the correct label."],
  ["translate", "The translation must be accurate and complete."],
  ["reason", "The final answer must be numerically/logically correct, not just well-argued."],
  ["qa-factual", "The stated fact must be correct."],
  ["plan", "The steps must be correct, ordered, and actually accomplish the goal."],
  ["rewrite", "It must satisfy the rewrite instruction while preserving meaning."],
];

export function judgeHintFor(taskType: string): string {
  let best = "";
  for (const [prefix, hint] of TYPE_HINTS) {
    if (taskType.startsWith(prefix) && prefix.length > best.length) best = hint;
  }
  return best;
}

// ─── Conversation context (#197) ────────────────────────────────────────────────
//
// The judge used to see ONLY the last user turn + completion, so on real multi-turn/agentic
// traffic it graded answers against a fraction of their context — the audit's smoking gun was a
// fail reason literally complaining "Only 23 messages, not 45; incomplete" about a conversation
// it couldn't see. These helpers give the judge a BOUNDED transcript of the earlier turns. The
// task/classification identity stays the last user turn (same as classifyTask and the gate), and
// a call WITHOUT context is byte-identical to the historical prompt, so the 2026-07-06 judge
// calibration (single-turn control set) remains valid.

/** Message shape shared with the replay/harvest loaders (structural match for their ChatMsg).
 *  `tool` turns survive sanitization since #216 — a tool RESULT must never pose as the user task,
 *  and the judge wants to see it as what it is. */
export interface JudgeContextMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Default char budget for the rendered context transcript (~6k tokens at ~4 chars/token).
 * gpt-oss-120b serves at -c 65536 on the box; worst observed task prompts are ~24KB chars and the
 * judge completion budget escalates to 16k tokens, so 24KB of context keeps the total comfortably
 * inside the window. Override per run with HARVEST_JUDGE_CONTEXT_CHARS (0 disables context).
 */
export const HARVEST_JUDGE_CONTEXT_CHARS_DEFAULT = 24_000;

/**
 * Split a logged request's messages into (task, context): the task is the LAST genuine user turn —
 * the same identity classifyTask and the disagreement gate key on — and `prior` is every OTHER
 * turn in original order. Turns AFTER the last user turn are context too (#216): on agentic rows
 * they are the assistant tool_call / tool result loop the graded ANSWER depends on —
 * chronologically between the ask and the answer — and dropping them (the pre-#216 behavior)
 * blinded the judge to exactly the conversation it was grading.
 */
export function splitTaskFromMessages(messages: readonly JudgeContextMsg[]): {
  task: string;
  prior: JudgeContextMsg[];
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      return { task: messages[i]!.content, prior: [...messages.slice(0, i), ...messages.slice(i + 1)] };
    }
  }
  return { task: "", prior: [] };
}

const TRUNCATION_MARK = "\n[… truncated …]\n";

/** Keep head + tail (both often carry signal: instructions up front, conclusions at the end). */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - TRUNCATION_MARK.length;
  if (keep <= 2) return s.slice(0, Math.max(0, max));
  const head = Math.ceil(keep / 2);
  return s.slice(0, head) + TRUNCATION_MARK + s.slice(s.length - (keep - head));
}

/** Share of the budget a leading system prompt may claim before recent turns get the rest. */
const CONTEXT_SYSTEM_SHARE = 0.25;

/** Below this many chars a truncated block is pure noise — omit the turn instead. */
const MIN_TRUNCATED_BLOCK = 16;

/** Separator between transcript parts (must match the join in buildJudgeContext). */
const CONTEXT_SEP = "\n\n";

/**
 * Message CONTENT that contains a line starting like a transcript role header ("[system]: …")
 * would render indistinguishably from a REAL turn boundary — untrusted text that flowed through a
 * prompt (web content in deep-research, pasted material) could forge a system-role instruction to
 * the judge, a materially stronger injection primitive than plain in-content text (agy review).
 * Mark such lines visibly as content (⟦role⟧:) so only blocks buildJudgeContext itself emits carry
 * the [role]: structure. Judge-side injection can't be fully prevented by escaping — the shadow
 * mode + trusted-verifier gates remain the real defence — but this closes the spoofed-turn shape.
 * CR is a line boundary too (codex retro review: lone-\r bypassed the old \n-only check).
 */
function neutralizeRoleHeaders(content: string): string {
  return content.replace(/(^|[\n\r])([ \t]*)\[(system|user|assistant|tool)\]:/gi, "$1$2⟦$3⟧:");
}

/**
 * Render ONE turn as `[role]: content`, hard-bounded to `max` chars. ORDER MATTERS (codex retro
 * review): normalize CR line endings, truncate FIRST, neutralize AFTER — middle-truncation splices
 * head+marker+tail and the marker ends in a newline, so it can PROMOTE an inline forged
 * "[system]:" to a line start that a pre-truncation neutralizer had (correctly, at the time)
 * skipped. The genuine role label is prepended last so it is never neutralized. Neutralization is
 * length-preserving (⟦/⟧ are single UTF-16 units); the final slice pins the bound regardless, and
 * a tail-slice cannot mint a new line-start header.
 */
function renderTurn(m: JudgeContextMsg, max: number): string {
  const label = `[${m.role}]: `;
  const normalized = m.content.replace(/\r\n?/g, "\n");
  const content = neutralizeRoleHeaders(truncateMiddle(normalized, Math.max(0, max - label.length)));
  return (label + content).slice(0, Math.max(0, max));
}

const omittedMarker = (n: number): string => `[… ${n} earlier message${n === 1 ? "" : "s"} omitted …]`;

/**
 * Render prior turns as a bounded, role-labelled transcript (oldest first). Budgeting favours
 * RECENCY — whole turns are kept newest-first and an explicit "[… N earlier messages omitted …]"
 * marker records any cut — with one exception: a LEADING system prompt (the task contract on
 * agentic traffic) is always kept, middle-truncated to at most CONTEXT_SYSTEM_SHARE of the budget.
 * If even the newest prior turn exceeds the budget it is middle-truncated rather than dropped, so
 * a multi-turn row never silently degrades back to context-blind grading. Accounting is exact
 * (codex retro review): separators are charged only where the final join emits them — the old flat
 * +2 per block truncated an exactly-fitting turn — the marker's own cost is settled by evicting
 * the oldest included turns when needed, and `output.length <= maxChars` holds for every positive
 * budget (enforced by construction plus a final guard).
 */
export function buildJudgeContext(prior: readonly JudgeContextMsg[], maxChars: number): string {
  if (prior.length === 0 || maxChars <= 0) return "";
  const head: string[] = [];
  let remaining = maxChars;
  let rest: readonly JudgeContextMsg[] = prior;
  if (prior[0]!.role === "system") {
    const sysMax = Math.min(remaining, Math.max(MIN_TRUNCATED_BLOCK, Math.floor(maxChars * CONTEXT_SYSTEM_SHARE)));
    const sysBlock = renderTurn(prior[0]!, sysMax);
    head.push(sysBlock);
    remaining -= sysBlock.length;
    rest = prior.slice(1);
  }

  // Greedy newest-first fill; a separator costs only when something already precedes the part.
  const included: string[] = [];
  let oldestIncluded = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    const sepCost = head.length + included.length > 0 ? CONTEXT_SEP.length : 0;
    const whole = renderTurn(rest[i]!, Number.MAX_SAFE_INTEGER);
    if (whole.length + sepCost <= remaining) {
      included.unshift(whole);
      remaining -= whole.length + sepCost;
      oldestIncluded = i;
      continue;
    }
    if (included.length === 0 && remaining - sepCost >= MIN_TRUNCATED_BLOCK) {
      // Newest prior turn doesn't fit whole — keep a truncated slice rather than no context.
      const truncated = renderTurn(rest[i]!, remaining - sepCost);
      included.unshift(truncated);
      remaining -= truncated.length + sepCost;
      oldestIncluded = i;
    }
    break;
  }
  let omitted = oldestIncluded;

  // Marker cost is settled exactly: recompute the assembled length (the list is tiny) and evict
  // the oldest included turns until the marker fits; if nothing is left to evict, skip the marker.
  const assemble = (withMarker: boolean): string =>
    [...head, ...(withMarker && omitted > 0 ? [omittedMarker(omitted)] : []), ...included].join(CONTEXT_SEP);
  let out = assemble(true);
  while (omitted > 0 && out.length > maxChars && included.length > 0) {
    included.shift();
    omitted++;
    out = assemble(true);
  }
  if (out.length > maxChars) out = assemble(false);
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}

/** System addendum sent ONLY when a context transcript is present (context-free calls unchanged). */
const JUDGE_CONTEXT_SYSTEM =
  "A CONVERSATION CONTEXT section (the other turns of the same conversation, oldest first, " +
  "possibly truncated — earlier turns and, on agentic rows, [tool] calls/results the assistant " +
  "produced while working on the TASK) precedes the TASK. Judge the ANSWER as the assistant's " +
  "reply to the TASK in that conversation — it may legitimately rely on facts established in the " +
  "context. If correctness hinges on turns you cannot see (omitted or truncated), grade 'partial' " +
  "and say so — do not guess 'pass', and do not 'fail' the answer solely for referencing unseen turns.";

export function buildJudgePrompt(
  taskType: string,
  prompt: string,
  completion: string,
  conversationContext?: string
): { system: string; user: string } {
  const hint = judgeHintFor(taskType);
  const ctx = conversationContext?.trim() ?? "";
  const systemParts = [JUDGE_SYSTEM];
  if (hint) systemParts.push(hint);
  if (ctx) systemParts.push(JUDGE_CONTEXT_SYSTEM);
  // Ctx-branch labels only — the no-context branch below is calibration-frozen (byte-identical).
  // "other turns", not "earlier turns" (#216 review): the transcript can include the assistant's
  // post-ask [tool] activity, and calling that "earlier" would invert the chronology for the judge.
  const user = ctx
    ? `CONVERSATION CONTEXT (other turns of this conversation, oldest first; may be truncated; ` +
      `[tool] turns are the assistant's tool activity for the TASK):\n${ctx}\n\n` +
      `TASK (the user message being judged):\n${prompt}\n\nASSISTANT'S ANSWER:\n${completion}`
    : `TASK:\n${prompt}\n\nASSISTANT'S ANSWER:\n${completion}`;
  return { system: systemParts.join("\n"), user };
}

// ─── Judge request body (pure) ───────────────────────────────────────────────────────
//
// Forcing an OpenAI `response_format: {type:"json_object"}` on the judge call engages llama.cpp's
// grammar-constrained decoding, which STRUCTURALLY prevents the gpt-oss "harmony" non-streaming 500
// (#166 / ggml-org/llama.cpp#25321) instead of merely retrying it — so gpt-oss-120b becomes a
// reliable judge that grades EVERY served model, including qwen-coder's own rows (which the
// qwen-coder default self-grade-skips). The judge output is JSON by contract (JUDGE_SYSTEM) and
// parseJudgeVerdict already accepts bare JSON, so constraining the shape needs no parser change.

/** The response_format the harvest judge sends by default. json_object ⇒ grammar-constrained decode. */
export const HARVEST_JUDGE_RESPONSE_FORMAT = { type: "json_object" } as const;

/**
 * Default token budget for a judge call. gpt-oss-120b is a harmony/REASONING model: its
 * reasoning_content is generated INSIDE max_tokens before any content, and on real traffic
 * (5–24 KB prompts) that reasoning alone runs 600–1200 tokens. The old 600 budget starved it —
 * measured on the box 2026-07-09 (nightly judge-err row #6132 replayed against loopback
 * llama-swap): max_tokens=600 → finish_reason "length", completion_tokens 600, content "" (the
 * exact "empty judge completion" the nightly logged); max_tokens=2000, same input → "stop",
 * 709 tokens, valid verdict; row #6127 needed 1155. The 2026-07-06 calibration missed this
 * because the control set's prompts are ≤171 chars. 4000 ≈ 3.5× the observed worst case, and a
 * starved call escalates further via escalateJudgeMaxTokens. Cheap: the verdict JSON itself is
 * ~40 tokens, so the budget is headroom, not spend. Override per run with HARVEST_JUDGE_MAX_TOKENS.
 */
export const HARVEST_JUDGE_MAX_TOKENS_DEFAULT = 4000;

/** Hard ceiling for starvation-escalated retries (2 doublings from the default). */
export const HARVEST_JUDGE_MAX_TOKENS_CAP = 16000;

/** The judge model's serving context window (gpt-oss-120b runs at `-c 65536` on the box). */
export const HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT = 65_536;

/** Conservative chars-per-token estimate for judge INPUT sizing (prose ~4, code/JSON lower). */
const JUDGE_CHARS_PER_TOKEN = 3.5;

/** Headroom for the chat template / role scaffolding the server adds around the messages. */
const JUDGE_CTX_MARGIN_TOKENS = 256;

/** Never request fewer completion tokens than this — a 0/negative max_tokens is a broken call. */
const JUDGE_MAX_TOKENS_FLOOR = 256;

/**
 * Cap a judge completion budget so estimated input + completion fits the serving window (agy
 * review): with #197's conversation context (or an operator-raised context budget) the input can
 * consume most of the serving window, and an uncapped starvation escalation to 16k completion
 * tokens could overflow it on the long multi-turn rows the context feature exists to grade. When
 * the input alone nearly fills the window, the floor keeps the request valid — the call may still
 * fail server-side, which surfaces
 * as a judge-err (row skipped), never as fabricated model evidence.
 */
export function capJudgeMaxTokens(
  requested: number,
  inputChars: number,
  ctxWindowTokens: number = HARVEST_JUDGE_CTX_WINDOW_TOKENS_DEFAULT,
  charsPerToken: number = JUDGE_CHARS_PER_TOKEN
): number {
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : JUDGE_CHARS_PER_TOKEN;
  const estInputTokens = Math.ceil(Math.max(0, inputChars) / cpt);
  const room = ctxWindowTokens - estInputTokens - JUDGE_CTX_MARGIN_TOKENS;
  return Math.max(JUDGE_MAX_TOKENS_FLOOR, Math.min(requested, room));
}

/** True when the prior turns contain actual conversational history, not just a system prefix. */
export function hasRealHistory(prior: readonly JudgeContextMsg[]): boolean {
  return prior.some((m) => m.role !== "system");
}

/** Chars the judge PROMPT TEMPLATE adds around task+answer+context (system + headers, generous). */
export const JUDGE_PROMPT_TEMPLATE_ALLOWANCE = 1600;

/**
 * Pre-flight sizing for a judge call (codex retro review): decide BEFORE building the prompt or
 * firing HTTP whether the row is gradeable at all, and how much conversation context fits.
 * `fixedChars` is the mandatory input (task + answer + template allowance); context is the
 * optional part, so it absorbs the squeeze first. When even the mandatory input exceeds the
 * window (minus margin and a minimum completion), the row is SKIPPED with an explicit
 * input-too-large reason — firing the doomed request would land as a generic judge-err and
 * silently bias harvested evidence against exactly the long rows. `charsPerToken` is tunable
 * (HARVEST_JUDGE_CHARS_PER_TOKEN): 3.5 is prose-calibrated and materially OVERESTIMATES the char
 * budget on CJK-heavy traffic (~1–2 chars/token) — lower it if the box grades bilingual content.
 */
export function planJudgeInput(p: {
  fixedChars: number;
  requestedContextChars: number;
  ctxWindowTokens: number;
  charsPerToken?: number;
}): { skip: false; contextChars: number } | { skip: true; reason: string } {
  const cpt =
    p.charsPerToken !== undefined && Number.isFinite(p.charsPerToken) && p.charsPerToken > 0
      ? p.charsPerToken
      : JUDGE_CHARS_PER_TOKEN;
  const inputBudgetTokens = p.ctxWindowTokens - JUDGE_CTX_MARGIN_TOKENS - JUDGE_MAX_TOKENS_FLOOR;
  const inputBudgetChars = Math.floor(inputBudgetTokens * cpt);
  if (p.fixedChars > inputBudgetChars) {
    return {
      skip: true,
      reason: `input-too-large (${p.fixedChars} mandatory chars > ~${inputBudgetChars} window budget)`,
    };
  }
  return { skip: false, contextChars: Math.max(0, Math.min(p.requestedContextChars, inputBudgetChars - p.fixedChars)) };
}

/**
 * Budget for the NEXT attempt after a starved judge call (finish_reason "length" with no usable
 * verdict). Retrying at the SAME budget is pointless — reasoning length at temperature 0 is
 * near-deterministic, which is exactly why the old retry loop burned 3 retries per starved row
 * on the 2026-07-08/09 nightlies without ever recovering one. Doubling converges in ≤2 steps
 * from the default to the cap. At or ABOVE the cap the budget is returned unchanged — it must
 * never LOWER an explicit operator override (HARVEST_JUDGE_MAX_TOKENS above the cap), and a
 * caller seeing next === current knows escalation is exhausted (fail fast, don't re-starve).
 */
export function escalateJudgeMaxTokens(current: number): number {
  const cur = Number.isFinite(current) && current > 0 ? current : HARVEST_JUDGE_MAX_TOKENS_DEFAULT;
  if (cur >= HARVEST_JUDGE_MAX_TOKENS_CAP) return cur;
  return Math.min(cur * 2, HARVEST_JUDGE_MAX_TOKENS_CAP);
}

export interface JudgeRequestBody {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  temperature: number;
  response_format?: { type: "json_object" };
}

/**
 * Build the chat-completions request body for a judge call. `responseFormat` defaults to
 * {type:"json_object"} (undefined ⇒ default ON); pass `null` to send an UNCONSTRAINED call — used
 * by the calibration harness to measure the format-500 rate the constraint is there to fix.
 */
export function buildJudgeBody(
  model: string,
  system: string,
  user: string,
  opts?: { responseFormat?: { type: "json_object" } | null; maxTokens?: number }
): JudgeRequestBody {
  const body: JudgeRequestBody = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: opts?.maxTokens ?? HARVEST_JUDGE_MAX_TOKENS_DEFAULT,
    temperature: 0,
  };
  const rf = opts?.responseFormat === undefined ? HARVEST_JUDGE_RESPONSE_FORMAT : opts.responseFormat;
  if (rf) body.response_format = { type: rf.type };
  return body;
}

// ─── Judge parsing ─────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Parse the judge's JSON verdict. Robust to surrounding prose/fences. Returns null when the output
 * has no usable verdict — the caller then SKIPS the row rather than recording a spurious `fail`
 * (a judge that couldn't answer is a judge error, not model evidence). `score` is derived from the
 * verdict when the judge omits or contradicts it, so the stored score is always verdict-consistent.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const v = typeof o["verdict"] === "string" ? o["verdict"].trim().toLowerCase() : "";
  if (v !== "pass" && v !== "partial" && v !== "fail") return null;
  const reasonRaw = typeof o["reason"] === "string" ? o["reason"].trim() : "";
  const reason = reasonRaw.replace(/\s+/g, " ").slice(0, 100);
  // Prefer the judge's explicit score, but keep it consistent with the verdict bucket so a
  // "pass" can't be stored with score 0.1 (or a "fail" with 0.9). Default from the verdict.
  const defaultScore = v === "pass" ? 1 : v === "partial" ? 0.5 : 0;
  const rawScore = typeof o["score"] === "number" ? clamp01(o["score"]) : defaultScore;
  const band: [number, number] = v === "pass" ? [0.7, 1] : v === "partial" ? [0.3, 0.7] : [0, 0.3];
  const score = Math.max(band[0], Math.min(band[1], rawScore));
  return { verdict: v, score, reason };
}

// ─── Judge response classification (pure) ────────────────────────────────────────────
//
// The nightly harvest's "judge-err: empty judge completion" (2026-07-08: 5, 2026-07-09: 4) was
// TOKEN STARVATION, not a transport error: gpt-oss-120b's reasoning channel consumed the whole
// max_tokens budget (finish_reason "length") before the content channel emitted a byte, so
// `content` came back "" — and the one "parse-fail" per run was the same failure at the boundary
// (the verdict JSON truncated mid-emission). Classifying the response shape lets the caller
// (a) retry starvation with an ESCALATED budget instead of the same one, and (b) report
// starvation distinctly instead of folding it into a generic judge error.

/** Minimal shape of an OpenAI chat-completions response the classifier needs. */
export interface JudgeChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null };
  }[];
  usage?: { completion_tokens?: number };
}

export type JudgeCompletionOutcome =
  | { kind: "ok"; content: string }
  | { kind: "starved"; detail: string }
  | { kind: "empty"; detail: string };

/**
 * Classify a judge chat-completions response:
 *   - ok      — usable content (including a complete verdict that happens to end exactly at the
 *               length boundary: if it parses, a retry would only waste a GPU slot).
 *   - starved — finish_reason "length" with no parseable verdict (empty OR truncated content).
 *               Retryable, but ONLY with a bigger budget (escalateJudgeMaxTokens).
 *   - empty   — no/blank content without a length finish (the residual gpt-oss blank-output case).
 */
export function classifyJudgeCompletion(resp: JudgeChatResponse): JudgeCompletionOutcome {
  const choice = resp.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const finish = choice?.finish_reason ?? "";
  const starvedDetail = () =>
    `finish_reason=length completion_tokens=${resp.usage?.completion_tokens ?? "?"} — reasoning ate the budget`;
  if (content.trim() !== "") {
    if (finish === "length" && parseJudgeVerdict(content) === null) {
      // Truncated mid-verdict by the token cap — the "parse-fail" flavour of starvation.
      return { kind: "starved", detail: starvedDetail() };
    }
    return { kind: "ok", content };
  }
  if (finish === "length") return { kind: "starved", detail: starvedDetail() };
  return { kind: "empty", detail: "empty judge completion" };
}

// ─── Verdict-writing eligibility (pure) ──────────────────────────────────────────────

/**
 * Should a judged row of this task type WRITE a verdict in this mode? The broad `other` catch-all
 * (taxonomy fallback for anything the keyword classifier can't place) is too noisy to teach
 * routing: the 2026-07-09 nightly graded 16 `other` rows spanning wholly unrelated work, 12 of
 * them fail — that is a property of the BUCKET, not of any model. So in verdict-writing mode
 * (`on`) excluded types are skipped; in shadow mode everything still flows (rows land as
 * outcome='unverified' — zero routing impact — and keep the judge-evaluation stats honest).
 * `excludedTaskTypes` comes from config.harvestExcludedTaskTypes (default ["other"], env
 * HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES; set it empty to disable the gate).
 */
export function shouldWriteVerdict(
  taskType: string,
  mode: HarvestMode,
  excludedTaskTypes: readonly string[]
): boolean {
  return mode !== "on" || !excludedTaskTypes.includes(taskType);
}

// ─── Record construction (pure) ────────────────────────────────────────────────────

export interface HarvestSourceRow {
  /** owner_request_log row id — kept in notes so a harvested verdict is auditable back to source. */
  id: number;
  /** Original traffic timestamp (ISO). Used verbatim as the ledger ts → idempotent re-harvest. */
  ts: string;
  /** The served model (may be a raw filename; canonicalized here). */
  model: string;
}

/**
 * Grading-policy epoch stamped into every harvest verdict (#217). Lineage:
 *   NULL (unstamped)     — pre-2026-07-11 epochs: context-blind judge (pre-#213), tool-coerced
 *                          task identity (pre-#216), parts-content dropped (pre-#222). This is
 *                          the excluded-taint window, mechanically selectable as
 *                          `judge_policy IS NULL` — no timestamp tribal knowledge needed.
 *   "ctx-tools-parts-v1" — #213 context-aware judge + #218 pre-flight sizing + #216 genuine-user
 *                          task identity / [tool] transcript + #222 parts flattening.
 * Bump this when grading semantics change materially, then run
 * `harvest-verdicts --rejudge-existing` to regrade stale-epoch rows with supersede-not-duplicate
 * semantics (ledger.supersedeHarvestVerdicts). Sibling of gate-chat-replay's LOADER_POLICY,
 * which versions replay ELIGIBILITY — this versions GRADING.
 */
export const HARVEST_JUDGE_POLICY = "ctx-tools-parts-v1";

/** The full per-row stamp: policy version + the row's EFFECTIVE context budget (post-sizing). */
export function buildJudgePolicyStamp(contextChars: number): string {
  return `${HARVEST_JUDGE_POLICY}|ctx=${contextChars}`;
}

/** Version part of a stamp ("v|settings" → "v"); null/empty → null (the pre-epoch marker). */
export function policyVersionOf(stamp: string | null | undefined): string | null {
  if (!stamp) return null;
  const i = stamp.indexOf("|");
  return i === -1 ? stamp : stamp.slice(0, i);
}

/** True iff the stamp's version is the CURRENT grading policy. NULL is never current. */
export function isCurrentPolicy(stamp: string | null | undefined): boolean {
  return policyVersionOf(stamp) === HARVEST_JUDGE_POLICY;
}

/**
 * Map (source row, task type, judge verdict, mode) → the exact ImportableDelegation to write.
 * Pure and deterministic so it can be unit-tested without a DB or a model. In shadow mode the
 * outcome is `unverified` (invisible to verdict math) with the intended verdict in `notes`; in on
 * mode it is the real outcome with a trusted-verifier name. `ts` is the source row's original
 * timestamp so importDelegations' content-hash id is stable across re-runs (idempotent).
 */
export function harvestRecord(p: {
  row: HarvestSourceRow;
  taskType: string;
  prompt: string;
  judge: JudgeVerdict;
  judgeModel: string;
  mode: HarvestMode;
  /** Grading-policy stamp for this verdict (#217) — buildJudgePolicyStamp(effectiveCtxChars). */
  judgePolicy: string;
}): ImportableDelegation {
  const modelId = canonicalModelId(p.row.model);
  const base = {
    ts: p.row.ts,
    taskType: p.taskType,
    modelId,
    prompt: p.prompt,
    score: p.judge.score,
    judgePolicy: p.judgePolicy,
  };
  if (p.mode === "shadow") {
    return {
      ...base,
      outcome: "unverified" as Outcome,
      verifier: `harvest-shadow:llm-judge:${p.judgeModel}`,
      source: "harvest-shadow",
      notes: `would=${p.judge.verdict} score=${p.judge.score.toFixed(2)} #${p.row.id}: ${p.judge.reason}`.slice(0, 240),
    };
  }
  return {
    ...base,
    outcome: p.judge.verdict as Outcome, // pass | partial | fail
    verifier: `llm-judge:${p.judgeModel}`,
    source: "harvest",
    notes: `#${p.row.id}: ${p.judge.reason}`.slice(0, 240),
  };
}
