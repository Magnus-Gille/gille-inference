/**
 * measure-swap-latency.ts — controlled measurement of llama-swap model cold-swap cost.
 *
 * `docs/keep-warm-mellum-design-note-2026-07-01.md` (recommendation #5) flags that the
 * keep-warm/pinning decision for mellum has NO real measured data behind it — only two stale,
 * informally-remembered numbers (~38s and ~8-10s) from unrelated sessions. This script produces
 * that data: for each served model, a cold (swap-in) call immediately followed by a warm (already
 * resident) call, so `swap_cost_ms ≈ cold - warm` isolates the swap+load tax from ordinary prefill.
 *
 * llama-swap API used (per src/homeserver/llamaswap-admin.ts's header comment — the proven
 * adapter for this box; endpoints are NOT guessed here):
 *   GET  <base>/v1/models           → {data:[{id,...}]}            — discover served models
 *   GET  <base>/running             → {running:[{model,state,...}]} — currently-resident model
 *   POST <base>/v1/chat/completions → a chat call; llama-swap auto-swaps the model in if needed
 *
 * This script talks to llama-swap directly (default http://127.0.0.1:8091, loopback,
 * unauthenticated) rather than going through src/homeserver/llamaswap-admin.ts's exported
 * listModels()/getLoaded(), because those resolve their origin via loadConfig() (gateway config,
 * API keys, etc.) — unnecessary coupling for a standalone measurement script. The wire shapes are
 * identical; only the origin resolution differs.
 *
 * Protocol per model M, STRICTLY SEQUENTIAL (one request in flight ever — this box's GPU is
 * serial; concurrent measurement calls would themselves cause swap thrash and invalidate the
 * numbers):
 *   1. GET /running → fromModel (whatever was resident before we touched M).
 *   2. Timed minimal chat completion to M (max_tokens 8, temperature 0) → cold_total_ms.
 *   3. Immediately repeat the identical call → warm_total_ms.
 *   4. swap_cost_ms = cold_total_ms - warm_total_ms.
 *   5. GET /running again → if the resident model isn't M, someone else's traffic raced in during
 *      the sample; flag it `contaminated: true` (excluded from the medians, still counted).
 *
 * `--repeats N` runs N full passes over the model list, rotating the order each pass (pass 0 =
 * given order, pass 1 = rotated by one, ...) so different from→to pairs get sampled instead of
 * always swapping FROM the same predecessor.
 *
 * Run ON the box, wrapped in the GPU lease (issue #88) so a concurrent cron job or owner session
 * can't collide with the measurement (see gpu-lease.ts / cli.ts `gpu run`). NEVER run this against
 * the live box without the lease — a matrix of models is exactly the kind of heavy multi-minute
 * job the lease exists to serialize:
 *
 *   cd /srv/gille-inference
 *   npx tsx src/homeserver/cli.ts gpu run --model swap-latency --eta 30m \
 *     --purpose swap-latency-matrix -- npx tsx scripts/measure-swap-latency.ts --repeats 2
 *
 * Output: JSONL rows appended to data/swap-latency-<UTC date>.jsonl (data/ is gitignored) plus a
 * markdown summary table on stdout (per-sample rows + per-model medians).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

// ── CLI args ─────────────────────────────────────────────────────────────────

export interface Args {
  base: string;
  /** Explicit model list (overrides discovery), or null to discover via GET /v1/models. */
  models: string[] | null;
  exclude: string[];
  repeats: number;
  timeoutS: number;
}

export const DEFAULT_BASE = "http://127.0.0.1:8091";

function requireNext(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return v;
}

function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse CLI args (pure — no I/O). Throws on malformed input; callers should catch and exit 1. */
export function parseArgs(argv: string[]): Args {
  let base = DEFAULT_BASE;
  let models: string[] | null = null;
  let exclude: string[] = [];
  let repeats = 1;
  let timeoutS = 300;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--base") {
      base = requireNext(argv, i, "--base");
      i++;
    } else if (a === "--models") {
      models = splitList(requireNext(argv, i, "--models"));
      i++;
    } else if (a === "--exclude") {
      exclude = splitList(requireNext(argv, i, "--exclude"));
      i++;
    } else if (a === "--repeats") {
      const raw = requireNext(argv, i, "--repeats");
      i++;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--repeats must be a positive integer, got "${raw}"`);
      }
      repeats = n;
    } else if (a === "--timeout-s") {
      const raw = requireNext(argv, i, "--timeout-s");
      i++;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--timeout-s must be a positive number, got "${raw}"`);
      }
      timeoutS = n;
    } else {
      throw new Error(`unrecognized argument: ${a}`);
    }
  }

  return { base: base.replace(/\/+$/, ""), models, exclude, repeats, timeoutS };
}

/** Remove excluded model ids (pure). */
export function applyExclude(models: string[], exclude: string[]): string[] {
  if (exclude.length === 0) return models;
  const drop = new Set(exclude);
  return models.filter((m) => !drop.has(m));
}

// ── Contamination + sample shaping (pure) ───────────────────────────────────

export interface SwapSample {
  model: string;
  /** 1-based pass index (which rotation of the model order this sample came from). */
  pass: number;
  /** Model that was resident before we started sampling `model` (may equal `model`). */
  fromModel: string | null;
  coldMs: number | null;
  warmMs: number | null;
  /** cold - warm; null if either call errored. */
  swapCostMs: number | null;
  contaminated: boolean;
  note: string | null;
  /** Non-null if the cold or warm chat call threw (e.g. timeout). */
  error: string | null;
  timestamp: string;
}

/** Decide contamination from what's resident right after the sample's two calls (pure). */
export function flagContaminated(
  model: string,
  afterModel: string | null
): { contaminated: boolean; note: string | null } {
  if (afterModel !== model) {
    return {
      contaminated: true,
      note: `expected "${model}" resident after sampling, observed "${afterModel ?? "(none)"}" — live traffic likely raced in`,
    };
  }
  return { contaminated: false, note: null };
}

export interface RawSampleInput {
  model: string;
  pass: number;
  fromModel: string | null;
  afterModel: string | null;
  coldMs: number | null;
  warmMs: number | null;
  error: string | null;
  timestamp: string;
}

/** Turn raw timing + running-endpoint observations into a shaped, contamination-flagged sample. */
export function shapeSample(input: RawSampleInput): SwapSample {
  const swapCostMs = input.coldMs !== null && input.warmMs !== null ? input.coldMs - input.warmMs : null;
  const { contaminated, note } = flagContaminated(input.model, input.afterModel);
  return {
    model: input.model,
    pass: input.pass,
    fromModel: input.fromModel,
    coldMs: input.coldMs,
    warmMs: input.warmMs,
    swapCostMs,
    contaminated,
    note,
    error: input.error,
    timestamp: input.timestamp,
  };
}

// ── Rotation ─────────────────────────────────────────────────────────────────

/** Rotate `arr` left by `n` positions (pure; n may be negative or >length). */
export function rotate<T>(arr: readonly T[], n: number): T[] {
  if (arr.length === 0) return [];
  const k = ((n % arr.length) + arr.length) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

// ── Median + per-model summary (pure) ───────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ModelSummary {
  model: string;
  n: number;
  nClean: number;
  nContaminated: number;
  medianColdMs: number | null;
  medianWarmMs: number | null;
  medianSwapCostMs: number | null;
}

/** Group samples by model and compute medians. Contaminated + errored samples are EXCLUDED from
 *  the medians (only a clean cold/warm pair gives a trustworthy number) but still counted. */
export function summarizeByModel(samples: SwapSample[]): ModelSummary[] {
  const byModel = new Map<string, SwapSample[]>();
  for (const s of samples) {
    const arr = byModel.get(s.model);
    if (arr) arr.push(s);
    else byModel.set(s.model, [s]);
  }

  const isNum = (x: number | null): x is number => x !== null;
  const out: ModelSummary[] = [];
  for (const [model, arr] of byModel) {
    const clean = arr.filter((s) => !s.contaminated && s.error === null);
    out.push({
      model,
      n: arr.length,
      nClean: clean.length,
      nContaminated: arr.filter((s) => s.contaminated).length,
      medianColdMs: median(clean.map((s) => s.coldMs).filter(isNum)),
      medianWarmMs: median(clean.map((s) => s.warmMs).filter(isNum)),
      medianSwapCostMs: median(clean.map((s) => s.swapCostMs).filter(isNum)),
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

// ── Markdown rendering (pure) ────────────────────────────────────────────────

function fmtMs(x: number | null): string {
  return x === null ? "—" : String(Math.round(x));
}

export function renderMarkdownTable(samples: SwapSample[], summaries: ModelSummary[]): string {
  const lines: string[] = [];
  lines.push("## Per-sample results");
  lines.push("");
  lines.push("| model | fromModel | cold_ms | warm_ms | swap_cost_ms | contaminated |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of samples) {
    lines.push(
      `| ${s.model} | ${s.fromModel ?? "(none)"} | ${fmtMs(s.coldMs)} | ${fmtMs(s.warmMs)} | ${fmtMs(s.swapCostMs)} | ${s.contaminated ? "yes" : "no"} |`
    );
  }
  lines.push("");
  lines.push("## Per-model medians (contaminated + errored samples excluded)");
  lines.push("");
  lines.push("| model | n | n_clean | n_contaminated | median_cold_ms | median_warm_ms | median_swap_cost_ms |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const sm of summaries) {
    lines.push(
      `| ${sm.model} | ${sm.n} | ${sm.nClean} | ${sm.nContaminated} | ${fmtMs(sm.medianColdMs)} | ${fmtMs(sm.medianWarmMs)} | ${fmtMs(sm.medianSwapCostMs)} |`
    );
  }
  return lines.join("\n");
}

// ── Injected I/O seam (DI — mirrors probe-runner.ts's ChatFn pattern) ───────

export interface MeasureDeps {
  /** Fire one minimal chat completion at `model`. Throws on non-2xx / timeout. */
  chat: (model: string) => Promise<void>;
  /** Return the currently-resident (state:"ready") model id, or null if idle. */
  getRunningModel: () => Promise<string | null>;
  now: () => number;
  nowIso: () => string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Query getRunningModel(), swallowing a throw (e.g. a transient /running timeout) to null rather
 *  than letting it escape — a monitoring hiccup must not abort the whole matrix mid-run. A null
 *  result naturally flows into flagContaminated() as "can't confirm the expected model is
 *  resident", which is the same safe (excluded-from-medians) outcome as an observed foreign
 *  model. */
async function safeGetRunningModel(deps: MeasureDeps): Promise<string | null> {
  try {
    return await deps.getRunningModel();
  } catch {
    return null;
  }
}

/** Measure one model at one pass: fromModel → cold call → warm call → afterModel → shaped sample. */
export async function measureOne(model: string, pass: number, deps: MeasureDeps): Promise<SwapSample> {
  const fromModel = await safeGetRunningModel(deps);

  let coldMs: number | null = null;
  let warmMs: number | null = null;
  let error: string | null = null;

  try {
    const t0 = deps.now();
    await deps.chat(model);
    coldMs = deps.now() - t0;
  } catch (err) {
    error = errMsg(err);
  }

  if (error === null) {
    try {
      const t1 = deps.now();
      await deps.chat(model);
      warmMs = deps.now() - t1;
    } catch (err) {
      error = errMsg(err);
    }
  }

  const afterModel = await safeGetRunningModel(deps);

  return shapeSample({
    model,
    pass,
    fromModel,
    afterModel,
    coldMs,
    warmMs,
    error,
    timestamp: deps.nowIso(),
  });
}

export interface RunMatrixOpts {
  models: string[];
  repeats: number;
  deps: MeasureDeps;
  /** Called after each sample is measured (used to append JSONL + log progress). */
  onSample?: (sample: SwapSample) => void;
}

/** Run the full model × repeats matrix, sequentially, rotating the model order each pass. */
export async function runMatrix(opts: RunMatrixOpts): Promise<SwapSample[]> {
  const samples: SwapSample[] = [];
  for (let pass = 0; pass < opts.repeats; pass++) {
    const order = rotate(opts.models, pass);
    for (const model of order) {
      const sample = await measureOne(model, pass + 1, opts.deps);
      samples.push(sample);
      opts.onSample?.(sample);
    }
  }
  return samples;
}

// ── Real network implementations (not unit-tested against a live box; stubbed in tests) ────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET <base>/v1/models → model ids. */
export async function discoverModels(base: string): Promise<string[]> {
  const res = await fetchWithTimeout(`${base}/v1/models`, {}, 10_000);
  if (!res.ok) throw new Error(`GET ${base}/v1/models → HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id);
}

interface RunningEntry {
  model: string;
  state: string;
}

/** GET <base>/running → the resident (state:"ready") model id, or null if idle. */
async function getRunningModel(base: string): Promise<string | null> {
  const res = await fetchWithTimeout(`${base}/running`, {}, 10_000);
  if (!res.ok) return null;
  const data = (await res.json()) as { running?: RunningEntry[] };
  const ready = (data.running ?? []).find((r) => r.state === "ready");
  return ready ? ready.model : null;
}

/** POST <base>/v1/chat/completions — minimal probe call; throws on non-2xx / timeout. */
function makeChat(base: string, timeoutMs: number): (model: string) => Promise<void> {
  return async (model: string) => {
    const res = await fetchWithTimeout(
      `${base}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
          temperature: 0,
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    await res.json().catch(() => undefined); // drain the body
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const discovered = args.models ?? (await discoverModels(args.base));
  const models = applyExclude(discovered, args.exclude);
  if (models.length === 0) {
    console.error("[measure-swap-latency] no models to measure (discovery/filter left an empty list).");
    process.exit(1);
  }

  const deps: MeasureDeps = {
    chat: makeChat(args.base, args.timeoutS * 1000),
    getRunningModel: () => getRunningModel(args.base),
    now: Date.now,
    nowIso: () => new Date().toISOString(),
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = `data/swap-latency-${dateStr}.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });

  console.error(
    `[measure-swap-latency] base=${args.base} models=${models.join(",")} repeats=${args.repeats} timeoutS=${args.timeoutS}`
  );
  console.error(`[measure-swap-latency] rows → ${outPath}\n`);

  const samples = await runMatrix({
    models,
    repeats: args.repeats,
    deps,
    onSample: (s) => {
      appendFileSync(outPath, JSON.stringify(s) + "\n");
      const tag = s.error ? `ERROR=${s.error.slice(0, 60)}` : `cold=${s.coldMs}ms warm=${s.warmMs}ms swap=${s.swapCostMs}ms`;
      console.error(
        `[pass ${s.pass}] ${s.model.padEnd(28)} from=${(s.fromModel ?? "(none)").padEnd(28)} ${tag}${s.contaminated ? "  CONTAMINATED" : ""}`
      );
    },
  });

  const summaries = summarizeByModel(samples);
  console.log("\n" + renderMarkdownTable(samples, summaries));
  console.log(`\nrows → ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
