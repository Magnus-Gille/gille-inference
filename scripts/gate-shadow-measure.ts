/**
 * gate-shadow-measure.ts — controlled live measurement of the disagreement gate (PR #90) on the box.
 *
 * Runs a sample of REAL owner sub-tasks (owner_request_log) through the PRODUCTION
 * `orchestrator.delegate()` with the gate forced to SHADOW, so we observe the gate's true behaviour
 * — which tasks it fires on, how often the two local models disagree, and the real per-task wall
 * cost (the mellum→qwen swap dominates) — using the real ledger code path on real data.
 *
 * SAFETY (Codex review of #95):
 *  - It writes to an ISOLATED SCRATCH COPY of eval.db, never the live ledger: `delegate()` records
 *    every attempt (incl. `outcome='error'` on a timeout) and `getVerdict()` counts non-unverified
 *    rows, so writing measurement runs into the live `delegations` table could nudge real routing.
 *    We online-backup the live DB to a temp file and point EVAL_DB_PATH at it — zero live mutation.
 *  - The gate is FORCED to shadow (not `||=`), so it never escalates and there is NO frontier/
 *    OpenRouter spend regardless of the ambient environment.
 *  - The config/db/orchestrator modules are imported DYNAMICALLY, AFTER the env is set, so the
 *    forced settings are guaranteed in effect before the cached singletons initialise (ESM static
 *    imports are hoisted above the module body, so a top-level `process.env[...] = ...` would NOT
 *    reliably precede them).
 *
 * Run ON the box, wrapped in the GPU lease so the swaps don't collide with another owner session:
 *   cd /srv/gille-inference
 *   npx tsx src/homeserver/cli.ts gpu run --model gate-shadow --eta 25m --purpose gate-shadow-measure \
 *     -- npx tsx scripts/gate-shadow-measure.ts --n 24
 *
 * Per-task results → data/gate-shadow-measure-<n>.jsonl (the durable artifact; the scratch DB is
 * deleted on exit).
 */
import { writeFileSync, unlinkSync } from "node:fs";

interface ChatMsg { role: string; content: string }

function sanitizeMessages(msgs: unknown): ChatMsg[] {
  if (!Array.isArray(msgs)) return [];
  const ok: ChatMsg[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const r = m as { role?: unknown; content?: unknown };
    if (typeof r.content !== "string" || !r.content.trim()) continue;
    const role = r.role === "system" || r.role === "assistant" ? r.role : "user";
    ok.push({ role, content: r.content });
  }
  return ok;
}

/** Deduped, stride-sampled real single-turn-ish owner sub-tasks with usable inputs. */
function loadTasks(
  DatabaseCtor: typeof import("better-sqlite3"),
  dbPath: string,
  limit: number
): { id: number; messages: ChatMsg[] }[] {
  const db = new DatabaseCtor(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, messages_json
         FROM owner_request_log
         WHERE messages_json IS NOT NULL AND length(messages_json) BETWEEN 40 AND 8000
         ORDER BY id DESC`
      )
      .all() as { id: number; messages_json: string }[];
    const eligible: { id: number; messages: ChatMsg[] }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.messages_json);
      } catch {
        continue;
      }
      const msgs = sanitizeMessages(parsed);
      if (msgs.length === 0) continue;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (!lastUser || lastUser.content.trim().length < 20) continue;
      const key = lastUser.content.slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      eligible.push({ id: r.id, messages: msgs });
    }
    if (eligible.length <= limit) return eligible;
    const step = eligible.length / limit;
    const out: { id: number; messages: ChatMsg[] }[] = [];
    for (let i = 0; i < limit; i++) out.push(eligible[Math.floor(i * step)]!);
    return out;
  } finally {
    db.close();
  }
}

interface ResultRow {
  id: number;
  taskType: string;
  primary: string;
  delegated: boolean;
  gateFired: boolean;
  gateModel: string | null;
  score: number | null;
  wouldEscalate: boolean | null;
  secondaryError: string | null;
  primaryLatencyMs: number | null;
  gateInferenceMs: number | null;
  wallMs: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nIdx = args.indexOf("--n");
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 12;
  if (!Number.isInteger(n) || n <= 0) {
    console.error("usage: gate-shadow-measure --n <positive-integer>");
    process.exit(1);
  }

  // ── Force shadow + isolate writes to a scratch DB BEFORE importing anything that reads config/db ──
  process.env["HOMESERVER_DISAGREEMENT_GATE"] = "shadow";
  const liveDbPath = process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
  const scratchPath = `${liveDbPath}.gate-shadow-measure.tmp`;
  const { default: DatabaseCtor } = await import("better-sqlite3");
  // Online backup = a consistent copy even while the live gateway is writing.
  const liveRo = new DatabaseCtor(liveDbPath, { readonly: true });
  await liveRo.backup(scratchPath);
  liveRo.close();
  process.env["EVAL_DB_PATH"] = scratchPath;

  // Dynamic imports: the cached config/db singletons now initialise against the forced env.
  const { delegate } = await import("../src/homeserver/orchestrator.js");
  const { loadConfig } = await import("../src/homeserver/config.js");

  const cleanup = () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(scratchPath + suffix);
      } catch {
        /* not present */
      }
    }
  };

  try {
    const cfg = loadConfig();
    if (cfg.disagreementGate !== "shadow") {
      throw new Error(`gate is '${cfg.disagreementGate}', not 'shadow' — forced-shadow setup failed`);
    }
    console.error(
      `[setup] gate=${cfg.disagreementGate} secondary=${cfg.disagreementGateModel} ` +
        `threshold=${cfg.disagreementGateThreshold} routingTable=${cfg.useRoutingTable} backend=${cfg.backend}`
    );
    console.error(`[setup] writes isolated to scratch copy ${scratchPath} (live ledger untouched)`);

    const tasks = loadTasks(DatabaseCtor, scratchPath, n);
    console.error(`[setup] sampled ${tasks.length} real owner sub-tasks\n`);

    const results: ResultRow[] = [];
    const t0 = Date.now();
    for (const [i, t] of tasks.entries()) {
      const lastUser = [...t.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const sys = t.messages.find((m) => m.role === "system")?.content;

      const w0 = Date.now();
      const out = await delegate({
        prompt: lastUser,
        ...(sys ? { systemPrompt: sys } : {}),
        source: "gate-shadow-measure",
        keyAlias: "local:gate-shadow-measure",
      });
      const wallMs = Date.now() - w0;
      const g = out.gate;
      results.push({
        id: t.id,
        taskType: out.taskType,
        primary: out.modelId,
        delegated: out.delegated,
        gateFired: !!g,
        gateModel: g?.model ?? null,
        score: g?.score ?? null,
        wouldEscalate: g?.wouldEscalate ?? null,
        secondaryError: g?.secondaryError ?? null,
        primaryLatencyMs: out.metrics?.latencyMs ?? null,
        gateInferenceMs: g?.latencyMs ?? null,
        wallMs,
      });
      const tag = g
        ? g.secondaryError
          ? `gate ERR=${g.secondaryError.slice(0, 30)}`
          : `gate score=${g.score.toFixed(2)} would-escalate=${g.wouldEscalate ? 1 : 0}`
        : out.delegated
          ? "gate skipped (secondary==primary)"
          : "escalated pre-local (no gate)";
      console.error(
        `[${i + 1}/${tasks.length}] #${t.id} ${out.taskType.padEnd(22)} primary=${out.modelId} ${tag} (${(wallMs / 1000).toFixed(1)}s)`
      );
    }
    const elapsedMs = Date.now() - t0;

    // ── Summary ──
    const fired = results.filter((r) => r.gateFired);
    const ok = fired.filter((r) => !r.secondaryError);
    const wouldEsc = ok.filter((r) => r.wouldEscalate);
    const errs = fired.filter((r) => r.secondaryError);
    const skippedSameModel = results.filter((r) => r.delegated && !r.gateFired);
    const escalatedNoLocal = results.filter((r) => !r.delegated);
    const fireRate = ok.length ? wouldEsc.length / ok.length : 0;
    const gatedWall = fired.map((r) => r.wallMs);
    const avgGatedS = gatedWall.length ? gatedWall.reduce((a, b) => a + b, 0) / gatedWall.length / 1000 : 0;
    const scores = ok.map((r) => r.score!).sort((a, b) => a - b);

    console.log("\n================ GATE SHADOW MEASUREMENT ================");
    console.log(`sampled tasks ............. ${results.length}`);
    console.log(`gate fired (ran qwen) ..... ${fired.length}  (${ok.length} ok, ${errs.length} secondary-error)`);
    console.log(`gate skipped (qwen-routed). ${skippedSameModel.length}  (secondary==primary)`);
    console.log(`escalated pre-local (sql).. ${escalatedNoLocal.length}`);
    console.log(`WOULD-ESCALATE (disagree).. ${wouldEsc.length} / ${ok.length} gated  →  live fire-rate ${(fireRate * 100).toFixed(1)}%`);
    console.log(`disagreement scores (gated) ${scores.length ? scores.map((s) => s.toFixed(2)).join(", ") : "(none)"}`);
    console.log(`avg wall / gated task ..... ${avgGatedS.toFixed(1)}s  (incl. mellum→qwen swap)`);
    console.log(`total wall ................ ${(elapsedMs / 1000 / 60).toFixed(1)} min`);
    if (wouldEsc.length) {
      console.log(`would-escalate task types . ${[...new Set(wouldEsc.map((r) => r.taskType))].join(", ")}`);
    }
    console.log("========================================================");

    const outPath = `data/gate-shadow-measure-${results.length}.jsonl`;
    writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`\nrows → ${outPath}  (live ledger untouched; scratch DB deleted)`);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
