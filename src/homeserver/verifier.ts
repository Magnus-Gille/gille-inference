import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome, ErrorClass } from "./ledger.js";

/**
 * Verifiers turn a local model's raw output into a graded outcome WITHOUT a frontier
 * model in the loop — that is what lets the ledger learn autonomously and for free.
 * A verifier is just `(output) => VerifyResult`. The factories below cover the common
 * deterministic checks; `tsGate` is the compile+run gate from the overnight harness
 * (findings F6: a tsc+test gate upgrades most one-line type slips that would otherwise
 * read as failures).
 */

const execFileAsync = promisify(execFile);

export interface VerifyResult {
  outcome: Outcome;
  score: number; // 0..1
  errorClass?: ErrorClass;
  notes?: string;
  /** Optional structured ground-truth evidence consumed by the probe runner. */
  reviewMetrics?: {
    expectedFindings: number;
    truePositives: number;
    reportedFindings: number;
    cleanControl: boolean;
    cleanConfabulated: boolean;
  };
}

export type Verifier = (output: string) => VerifyResult | Promise<VerifyResult>;

const PASS = (notes?: string): VerifyResult => ({ outcome: "pass", score: 1, notes });
const FAIL = (notes?: string): VerifyResult => ({ outcome: "fail", score: 0, notes });
const PARTIAL = (score: number, notes?: string): VerifyResult => ({ outcome: "partial", score, notes });

// ─── Text helpers ────────────────────────────────────────────────────────────────

/** Remove <think>…</think> reasoning traces some models leak into content. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
}

/** Extract the first fenced code block (preferring ts/js); fall back to whole text. */
export function extractCodeBlock(text: string, langs = ["typescript", "ts", "js", "javascript"]): string {
  const cleaned = stripThink(text);
  const fence = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let firstAny: string | null = null;
  while ((m = fence.exec(cleaned)) !== null) {
    const lang = (m[1] ?? "").toLowerCase();
    const body = m[2] ?? "";
    if (firstAny === null) firstAny = body;
    if (langs.includes(lang)) return body.trim();
  }
  return (firstAny ?? cleaned).trim();
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

// ─── Factories ───────────────────────────────────────────────────────────────────

export function nonEmpty(minLen = 1): Verifier {
  return (out) => (stripThink(out).length >= minLen ? PASS() : { outcome: "error", score: 0, errorClass: "empty", notes: "empty output" });
}

export function exact(expected: string, opts: { ci?: boolean } = {}): Verifier {
  return (out) => {
    const a = norm(stripThink(out));
    const b = norm(expected);
    const eq = opts.ci ? a.toLowerCase() === b.toLowerCase() : a === b;
    return eq ? PASS() : FAIL(`expected "${b}", got "${a.slice(0, 120)}"`);
  };
}

/** Output must contain the expected answer somewhere (good for short-answer probes). */
export function answerIs(expected: string, opts: { ci?: boolean } = {}): Verifier {
  return (out) => {
    const a = stripThink(out);
    const hay = opts.ci === false ? a : a.toLowerCase();
    const needle = opts.ci === false ? expected : expected.toLowerCase();
    return hay.includes(needle) ? PASS() : FAIL(`answer "${expected}" not found in output`);
  };
}

export function containsAll(subs: string[], opts: { ci?: boolean } = {}): Verifier {
  return (out) => {
    const hay = opts.ci === false ? stripThink(out) : stripThink(out).toLowerCase();
    const hits = subs.filter((s) => hay.includes(opts.ci === false ? s : s.toLowerCase()));
    if (hits.length === subs.length) return PASS();
    if (hits.length === 0) return FAIL(`none of [${subs.join(", ")}] present`);
    return PARTIAL(hits.length / subs.length, `${hits.length}/${subs.length} required substrings`);
  };
}

/** Fail if the output contains ANY of the given substrings — useful for "must-not-contain" guards. */
export function containsNone(subs: string[], opts: { ci?: boolean } = {}): Verifier {
  return (out) => {
    const hay = opts.ci === false ? stripThink(out) : stripThink(out).toLowerCase();
    const hits = subs.filter((s) => hay.includes(opts.ci === false ? s : s.toLowerCase()));
    return hits.length === 0 ? PASS() : FAIL(`output contains forbidden: [${hits.join(", ")}]`);
  };
}

export function matches(re: RegExp, label = re.source): Verifier {
  return (out) => (re.test(stripThink(out)) ? PASS() : FAIL(`no match for /${label}/`));
}

/** Extract the last number in the output and compare to expected within tolerance. */
export function numeric(expected: number, tol = 1e-9): Verifier {
  return (out) => {
    const nums = stripThink(out).match(/-?\d[\d,]*\.?\d*/g);
    if (!nums || nums.length === 0) return FAIL("no number in output");
    const val = Number(nums[nums.length - 1]!.replace(/,/g, ""));
    return Math.abs(val - expected) <= tol ? PASS(`= ${val}`) : FAIL(`expected ${expected}, got ${val}`);
  };
}

export function maxLength(max: number, opts: { min?: number } = {}): Verifier {
  return (out) => {
    const len = stripThink(out).length;
    if (opts.min !== undefined && len < opts.min) return FAIL(`too short (${len} < ${opts.min})`);
    return len <= max ? PASS(`${len} chars`) : FAIL(`too long (${len} > ${max})`);
  };
}

/** Parse output (or its first code/JSON block) as JSON and run an optional predicate. */
export function jsonValid(predicate?: (value: unknown) => boolean | string): Verifier {
  return (out) => {
    const raw = extractCodeBlock(out, ["json"]);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // try to find a JSON object/array substring
      const m = raw.match(/[[{][\s\S]*[\]}]/);
      if (!m) return { outcome: "error", score: 0, errorClass: "parse", notes: "output is not JSON" };
      try {
        value = JSON.parse(m[0]);
      } catch {
        return { outcome: "error", score: 0, errorClass: "parse", notes: "output is not valid JSON" };
      }
    }
    if (!predicate) return PASS();
    const r = predicate(value);
    if (r === true) return PASS();
    return FAIL(typeof r === "string" ? r : "predicate failed");
  };
}

export function predicate(fn: (out: string) => boolean | VerifyResult, label = "predicate"): Verifier {
  return (out) => {
    const r = fn(stripThink(out));
    if (typeof r === "boolean") return r ? PASS(label) : FAIL(label);
    return r;
  };
}

/**
 * Grade a Ratatoskr concierge decision using the same strict shape that can actually serve.
 *
 * Ratatoskr strips one optional JSON fence, parses the whole remaining payload, and accepts:
 * - ready only when task.prompt and task.title are truthy (context/timeout have production defaults)
 * - clarify only when question is truthy
 * - answer only when reply is truthy
 *
 * The expected action is still closed over from the labeled corpus. Keeping this separate from
 * jsonValid() is load-bearing: jsonValid deliberately salvages JSON substrings, while Ratatoskr's
 * strict M5 path falls back when trailing prose or a malformed envelope is present.
 */
export function triageGroundTruth(expected: "ready" | "clarify" | "answer"): Verifier {
  return (out) => {
    const cleaned = out
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return {
        outcome: "error",
        score: 0,
        errorClass: "parse",
        notes: "triage output is not strict JSON",
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return FAIL("triage decision must be an object");
    }
    const row = parsed as Record<string, unknown>;
    if (row["action"] !== expected) return FAIL(`expected action ${expected}`);

    if (expected === "ready") {
      const task = row["task"];
      if (task === null || typeof task !== "object" || Array.isArray(task)) {
        return FAIL("ready requires task");
      }
      const t = task as Record<string, unknown>;
      return t["prompt"] && t["title"] ? PASS() : FAIL("ready requires prompt and title");
    }
    const field = expected === "clarify" ? "question" : "reply";
    return row[field] ? PASS() : FAIL(`${expected} requires ${field}`);
  };
}

/**
 * Deterministic seeded-bug grader for the weekly scout (#158).
 *
 * The prompt gives every reviewable line a stable id (for example `L4`). The model returns
 * `{ "findings": ["L4"] }`; this verifier compares those ids with the closed-over manifest and
 * emits the sufficient statistics needed to aggregate recall, precision and clean-control
 * confabulation. Unknown/duplicate ids never earn credit, and unknown ids count against precision.
 */
export function reviewGroundTruth(expected: readonly string[]): Verifier {
  const gold = new Set(expected);
  return (out) => {
    const raw = extractCodeBlock(out, ["json"]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        outcome: "error",
        score: 0,
        errorClass: "parse",
        notes: "review output is not valid JSON",
      };
    }
    const findings =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["findings"]
        : undefined;
    if (!Array.isArray(findings) || !findings.every((v: unknown) => typeof v === "string")) {
      return {
        outcome: "error",
        score: 0,
        errorClass: "parse",
        notes: 'expected {"findings":["L<n>", ...]}',
      };
    }

    const reported = [
      ...new Set(
        (findings as string[]).map((id) => id.trim())
      ),
    ].filter(Boolean);
    const truePositives = reported.filter((id) => gold.has(id)).length;
    const recall = gold.size === 0 ? 1 : truePositives / gold.size;
    const precision = reported.length === 0 ? (gold.size === 0 ? 1 : 0) : truePositives / reported.length;
    const score = gold.size === 0 ? (reported.length === 0 ? 1 : 0) : (2 * recall * precision) / (recall + precision || 1);
    const outcome: Outcome = score === 1 ? "pass" : score > 0 ? "partial" : "fail";
    return {
      outcome,
      score,
      notes: `recall=${truePositives}/${gold.size}; precision=${truePositives}/${reported.length}; clean-confab=${gold.size === 0 && reported.length > 0 ? 1 : 0}`,
      reviewMetrics: {
        expectedFindings: gold.size,
        truePositives,
        reportedFindings: reported.length,
        cleanControl: gold.size === 0,
        cleanConfabulated: gold.size === 0 && reported.length > 0,
      },
    };
  };
}

/** Combine verifiers; outcome is the worst, score is the mean. */
export function all(verifiers: Verifier[]): Verifier {
  return async (out) => {
    if (verifiers.length === 0) return { outcome: "unverified", score: 0, notes: "no verifiers" };
    const results = await Promise.all(verifiers.map((v) => v(out)));
    const rank: Record<Outcome, number> = { pass: 3, partial: 2, unverified: 1, fail: 0, error: -1 };
    let worst = results[0]!;
    let sum = 0;
    for (const r of results) {
      sum += r.score;
      if (rank[r.outcome] < rank[worst.outcome]) worst = r;
    }
    return { outcome: worst.outcome, score: sum / results.length, errorClass: worst.errorClass, notes: results.map((r) => r.notes).filter(Boolean).join("; ") };
  };
}

// ─── TypeScript compile + run gate ───────────────────────────────────────────────

export interface TsGateOptions {
  /** Test harness appended after the candidate code. Use `throw` to signal failure. */
  harness: string;
  /** Run `tsc --noEmit --strict` first; a type error → partial (logic may be fine). */
  typecheck?: boolean;
  /** Languages to prefer when extracting the code block. */
  langs?: string[];
  timeoutMs?: number;
}

/**
 * Compile and execute the model's code against a harness. The candidate code block is
 * extracted, concatenated with `harness`, written to a temp file, optionally type-checked
 * with tsc, then executed with tsx. tsx exit 0 → pass. Type error but runtime pass →
 * partial (the F6 "one-line type slip with correct logic underneath" case). Runtime
 * throw → fail. Tooling/invocation failure → infra error (not the model's fault).
 */
export function tsGate(opts: TsGateOptions): Verifier {
  return async (out) => {
    const code = extractCodeBlock(out, opts.langs ?? ["typescript", "ts", "js", "javascript"]);
    if (!code) return { outcome: "error", score: 0, errorClass: "empty", notes: "no code block" };

    const dir = mkdtempSync(join(tmpdir(), "hs-gate-"));
    const file = join(dir, "candidate.ts");
    const source = `${code}\n\n// ── harness ──\n${opts.harness}\n`;
    writeFileSync(file, source, "utf-8");
    const timeout = opts.timeoutMs ?? 30_000;

    try {
      let typeOk = true;
      let typeNote = "";
      if (opts.typecheck !== false) {
        try {
          await execFileAsync(
            "npx",
            ["--no-install", "tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--moduleDetection", "force", "--module", "preserve", file],
            { timeout, cwd: process.cwd() }
          );
        } catch (err: unknown) {
          // tsc exits non-zero on type errors; distinguish "tsc not found" (infra).
          const e = err as { code?: string; stdout?: string; stderr?: string; message?: string };
          if (e.code === "ENOENT") return { outcome: "error", score: 0, errorClass: "infra", notes: "tsc not available" };
          typeOk = false;
          typeNote = (e.stdout ?? e.message ?? "type error").toString().split("\n").slice(0, 3).join(" ");
        }
      }

      // Runtime execution
      try {
        await execFileAsync("npx", ["--no-install", "tsx", file], { timeout, cwd: process.cwd() });
      } catch (err: unknown) {
        const e = err as { code?: string; killed?: boolean; signal?: string; stderr?: string; message?: string };
        if (e.code === "ENOENT") return { outcome: "error", score: 0, errorClass: "infra", notes: "tsx not available" };
        if (e.killed || e.signal === "SIGTERM") return { outcome: "error", score: 0, errorClass: "timeout", notes: "execution timed out" };
        const stderr = (e.stderr ?? e.message ?? "").toString().split("\n").slice(0, 4).join(" ");
        return FAIL(`runtime: ${stderr.slice(0, 200)}`);
      }

      if (!typeOk) return PARTIAL(0.6, `runtime PASS but type error: ${typeNote.slice(0, 160)}`);
      return PASS("compile + run OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ─── SQL execution gate (ground-truth, #156) ───────────────────────────────────────

export interface SqlExecOptions {
  /** Fixture DDL — CREATE TABLE … statements. */
  schema: string;
  /** Fixture rows — INSERT … statements. */
  seed?: string;
  /** Expected result rows (each an array of cell values). Column ORDER within a row is not compared. */
  expected: Array<Array<string | number | null>>;
  /** Whether ROW order must match (default true — for ranking/ORDER BY questions). */
  orderMatters?: boolean;
  /** Safety cap on rows read from a candidate query (default max(1000, expected.length*20)). */
  maxRows?: number;
  /** Hard wall-clock cap for executing the candidate SQL in a child process (default 2000ms). */
  timeoutMs?: number;
  label?: string;
}

const SQL_EXEC_CHILD = String.raw`
const Database = require("better-sqlite3");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const normRow = (r) => JSON.stringify(r.map((c) => (c === null ? "\u0000null" : String(c))));
const normList = (rows, orderMatters) => {
  const mapped = rows.map(normRow);
  return JSON.stringify(orderMatters ? mapped : [...mapped].sort());
};
const done = (value) => {
  process.stdout.write(JSON.stringify(value));
};
const db = new Database(":memory:");
try {
  try {
    db.exec(input.schema);
    if (input.seed) db.exec(input.seed);
  } catch (e) {
    done({ kind: "fixture-error", message: e instanceof Error ? e.message : String(e) });
    process.exit(0);
  }
  db.pragma("query_only = ON");
  let rows = [];
  let capped = false;
  try {
    const stmt = db.prepare(input.sql).raw();
    for (const r of stmt.iterate()) {
      rows.push(r);
      if (rows.length > input.cap) {
        capped = true;
        break;
      }
    }
  } catch (e) {
    done({ kind: "fail", notes: "SQL error: " + (e instanceof Error ? e.message : String(e)).slice(0, 140) });
    process.exit(0);
  }
  if (capped) {
    done({ kind: "fail", notes: "query returned > " + input.cap + " rows (pathological / incorrect)" });
    process.exit(0);
  }
  const want = normList(input.expected, input.orderMatters);
  if (normList(rows, input.orderMatters) === want) {
    done({ kind: "pass", notes: rows.length + " rows match" });
    process.exit(0);
  }
  const preview = rows.slice(0, 3).map((r) => JSON.stringify(r)).join("; ");
  done({
    kind: "fail",
    notes: "result mismatch: expected " + input.expected.length + " rows, got " + rows.length + (preview ? " [" + preview + "]" : ""),
  });
} finally {
  db.close();
}
`;

type SqlChildResult =
  | { kind: "pass"; notes: string }
  | { kind: "fail"; notes: string }
  | { kind: "fixture-error"; message: string };

async function runSqlExecChild(input: {
  schema: string;
  seed?: string;
  sql: string;
  expected: Array<Array<string | number | null>>;
  orderMatters: boolean;
  cap: number;
}, timeoutMs: number): Promise<SqlChildResult | "timeout" | "infra-error"> {
  const arg = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  try {
    const { stdout } = await execFileAsync(process.execPath, ["-e", SQL_EXEC_CHILD, arg], {
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
    });
    return JSON.parse(stdout.trim()) as SqlChildResult;
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; code?: string; message?: string };
    if (err.killed || err.signal === "SIGTERM" || /timed out/i.test(String(err.message ?? ""))) return "timeout";
    return "infra-error";
  }
}

/**
 * Ground-truth SQL grader (#156). Runs the model's SQL against an in-memory SQLite DB seeded with
 * fixture data and compares the RESULT SET to `expected` — so a query that merely contains the right
 * keywords (what `containsAll` certified) but computes the wrong thing (e.g. COUNT for SUM) now FAILS.
 * Follows the `tsGate` pattern: `schema`/`seed`/`expected` are closed over at construction; the
 * verifier still receives only the model output string.
 *
 * Rows are compared POSITIONALLY (each cell coerced with String(); column order is preserved because
 * it is part of correctness), either sequentially (orderMatters) or as a set. Safety: after seeding,
 * the connection is set `query_only`, so a candidate `WITH…DELETE`/`DROP` is REJECTED, never executed;
 * a multi-statement string is rejected by prepare() (the tail never runs); the row count is capped; the
 * DB is in-memory and discarded. A schema/seed error THROWS (a probe-definition bug — surface it
 * loudly); a candidate SQL error or non-query is a model FAIL. NOTE: there is no CPU-time guard —
 * fixtures are tiny and the graded queries terminate; do not point this at adversarial input.
 */
export function sqlExec(opts: SqlExecOptions): Verifier {
  const orderMatters = opts.orderMatters ?? true;
  const cap = opts.maxRows ?? Math.max(1000, opts.expected.length * 20);
  const timeoutMs = opts.timeoutMs ?? 2000;

  return async (out) => {
    // Take from the first SELECT/WITH (drops leading prose); strip a single TRAILING ';' terminator.
    // A genuine multi-statement string is left intact and rejected by prepare() below (its tail never
    // runs) — we do NOT regex-truncate at the first ';', which would corrupt a ';' inside a literal.
    let sql = extractCodeBlock(out, ["sql"]).trim();
    const idx = sql.search(/\b(?:select|with)\b/i);
    if (idx < 0) return FAIL("no SELECT/WITH query in output");
    sql = sql.slice(idx).trim().replace(/;\s*$/, "");
    if (!sql) return FAIL("empty query");

    const result = await runSqlExecChild(
      { schema: opts.schema, seed: opts.seed, sql, expected: opts.expected, orderMatters, cap },
      timeoutMs
    );
    if (result === "timeout") return FAIL(`SQL timeout after ${timeoutMs}ms`);
    if (result === "infra-error") return { outcome: "error", score: 0, errorClass: "infra", notes: "sqlExec child process failed" };
    if (result.kind === "fixture-error") throw new Error(`sqlExec fixture (schema/seed) is invalid — probe bug: ${result.message}`);
    return result.kind === "pass" ? PASS(result.notes) : FAIL(result.notes);
  };
}
