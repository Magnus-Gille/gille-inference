/**
 * T2 ledger re-derivation — retro-fix the delegations ledger's task_type labels with mellum.
 *
 * The inline `classifyTask()` keyword classifier (~50% accurate) tagged every recorded delegation's
 * `task_type`. Because each row also stored a `prompt_excerpt`, the label is re-derivable OFFLINE
 * with the better `classifyTaskLLM()` (mellum) — no re-running of any real work.
 *
 * This script is NON-DESTRUCTIVE and SCOPED:
 *   - It adds a NEW column `task_type_llm` to the `delegations` table (the original `task_type` is
 *     preserved untouched — keyword vs LLM stay side by side for comparison/auditing).
 *   - It ONLY reads/writes the `delegations` table. It never touches the keystore, credits,
 *     request_log, or any other table in eval.db.
 *   - It is idempotent/resumable: by default only rows with a NULL `task_type_llm` are processed,
 *     so a re-run continues where it stopped. `--all` re-derives every row.
 *   - `--dry-run` computes + reports WITHOUT any schema change or write.
 *
 * ALWAYS back up eval.db before a real (non-dry-run) run — it shares the file with the live
 * keystore + credits. On the box:  cp data/eval.db data/eval.db.bak-<stamp>
 *
 * Run ON the box (mellum is local, free):
 *   MELLUM_BASE_URL=http://localhost:8091/v1 EVAL_DB_PATH=./data/eval.db \
 *     ./node_modules/.bin/tsx scripts/t2-rederive-ledger.ts --dry-run        # preview
 *   …same without --dry-run to write.
 * Mechanics test (no box/mellum): add --mock.
 */

import Database from "better-sqlite3";
import type { ChatFn } from "../src/homeserver/deep-research-types.js";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import { classifyTaskLLM } from "../src/homeserver/task-classifier-llm.js";
import { classifyTask } from "../src/homeserver/taxonomy.js";

interface Row {
  id: string;
  task_type: string;
  prompt_excerpt: string | null;
  task_type_llm: string | null;
}

/**
 * The 5 deep-research pipeline roles are PIPELINE-STAGE-assigned, not content-derivable (the same
 * reason classifyTaskLLM excludes them from its candidate universe). For these rows the original
 * task_type is AUTHORITATIVE — re-deriving with the generic classifier produces a strictly worse
 * label (e.g. source-distill → "summarize"). So we PRESERVE it: task_type_llm = task_type, no model
 * call. Only content-classified rows (cartography / mcp-ask offloads) get re-derived with mellum.
 */
const DEEP_RESEARCH_ROLES = new Set([
  "research-plan",
  "source-distill",
  "claim-verify",
  "gap-check",
  "synthesis",
]);

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  return rows.some((r) => r.name === col);
}

/** Mock ChatFn for --mock (mechanics only): re-uses the keyword classifier as a stand-in. */
function mockChat(): ChatFn {
  return async (req) => {
    // The classification prompt ends with the fenced task text; pull it back out cheaply.
    const m = req.prompt.match(/BEGIN TASK TEXT ---\n([\s\S]*?)\n--- END TASK TEXT/);
    const text = m ? m[1]! : req.prompt;
    const t = classifyTask(text).taskType;
    return { text: t, promptTokens: req.prompt.length / 4, completionTokens: t.length, model: "mock-keyword" };
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const mock = args.includes("--mock");
  const all = args.includes("--all");
  const limIdx = args.indexOf("--limit");
  const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;

  const dbPath = process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
  console.log(`T2 ledger re-derivation`);
  console.log(`  db: ${dbPath}  mode: ${dryRun ? "DRY-RUN (no writes)" : "WRITE"}${mock ? " [mock chat]" : ""}\n`);

  const db = new Database(dbPath, { readonly: dryRun });
  db.pragma("journal_mode = WAL");

  const colExists = hasColumn(db, "delegations", "task_type_llm");
  if (!colExists && dryRun) {
    console.log("  (dry-run) task_type_llm column does not exist yet — would be added on a real run.");
  }
  if (!colExists && !dryRun) {
    db.exec(`ALTER TABLE delegations ADD COLUMN task_type_llm TEXT`);
    console.log("  added column delegations.task_type_llm");
  }

  // Select rows to process. In dry-run the column may not exist → fall back to selecting all
  // excerpt-bearing rows and treat task_type_llm as NULL.
  const selectCols = colExists || !dryRun ? "id, task_type, prompt_excerpt, task_type_llm" : "id, task_type, prompt_excerpt, NULL AS task_type_llm";
  let rows = db.prepare(`SELECT ${selectCols} FROM delegations WHERE prompt_excerpt IS NOT NULL`).all() as Row[];
  const totalWithExcerpt = rows.length;
  if (!all) rows = rows.filter((r) => r.task_type_llm == null);
  if (Number.isFinite(limit)) rows = rows.slice(0, limit);

  const totalRows = (db.prepare(`SELECT count(*) c FROM delegations`).get() as { c: number }).c;
  console.log(`  delegations rows: ${totalRows} total, ${totalWithExcerpt} with prompt_excerpt`);
  console.log(`  to process this run: ${rows.length}${all ? " (--all)" : " (task_type_llm IS NULL)"}\n`);

  const chat: ChatFn = mock
    ? mockChat()
    : makeChatFn(
        process.env["MELLUM_BASE_URL"] ?? "http://localhost:8091/v1",
        process.env["MELLUM_API_KEY"] ?? "x",
        process.env["MELLUM_MODEL"] ?? "mellum"
      );

  const update = colExists || !dryRun ? db.prepare(`UPDATE delegations SET task_type_llm = ? WHERE id = ?`) : null;
  const results: { id: string; old: string; neu: string; preserved: boolean }[] = [];
  let done = 0;
  let preservedCount = 0;
  let failed = 0;
  for (const r of rows) {
    let neu: string;
    let preserved = false;
    if (DEEP_RESEARCH_ROLES.has(r.task_type)) {
      // Authoritative pipeline-role label — preserve it, no model call.
      neu = r.task_type;
      preserved = true;
      preservedCount++;
    } else {
      try {
        neu = (await classifyTaskLLM(r.prompt_excerpt!, chat)).taskType;
      } catch (err) {
        // classifyTaskLLM never throws on junk OUTPUT (it falls back), but the underlying chat
        // fn rejects on a network/HTTP error (mellum hiccup). Isolate it per-row: leave
        // task_type_llm NULL so a later resumable run retries just this row, and keep going.
        failed++;
        console.warn(`  [skip] row ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
        done++;
        continue;
      }
    }
    results.push({ id: r.id, old: r.task_type, neu, preserved });
    if (!dryRun && update) update.run(neu, r.id);
    done++;
    if (done % 50 === 0 || done === rows.length) process.stdout.write(`  ${done}/${rows.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`  preserved ${preservedCount} deep-research pipeline-role rows (authoritative; not re-derived)`);
  if (failed) console.log(`  ⚠️ ${failed} rows FAILED (model error) — left NULL, re-run (default mode) to retry just those`);

  // ── Report ── (agreement measured over the RE-DERIVED rows only; preserved rows trivially agree)
  const rederived = results.filter((r) => !r.preserved);
  const agree = rederived.filter((r) => r.old === r.neu).length;
  const pct = rederived.length ? ((100 * agree) / rederived.length).toFixed(1) : "—";
  console.log(`\n  keyword task_type vs mellum task_type_llm (re-derived content rows only, n=${rederived.length}):`);
  console.log(`    agreement: ${agree}/${rederived.length} = ${pct}%  (so ${rederived.length - agree} labels CHANGED)`);

  const changes = new Map<string, number>();
  for (const r of rederived) if (r.old !== r.neu) changes.set(`${r.old} → ${r.neu}`, (changes.get(`${r.old} → ${r.neu}`) ?? 0) + 1);
  if (changes.size) {
    console.log(`\n  top label changes (keyword → mellum):`);
    [...changes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}  ${k}`));
  }

  const dist = new Map<string, number>();
  for (const r of results) dist.set(r.neu, (dist.get(r.neu) ?? 0) + 1);
  console.log(`\n  new (mellum) task_type distribution over processed rows:`);
  [...dist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}  ${k}`));

  if (dryRun) console.log(`\n  DRY-RUN — no schema change, no writes. Re-run without --dry-run to persist.`);
  else console.log(`\n  WROTE task_type_llm for ${results.length} rows. Original task_type untouched.`);

  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
