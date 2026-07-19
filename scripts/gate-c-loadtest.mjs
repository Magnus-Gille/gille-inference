#!/usr/bin/env node
/**
 * Gate C / T9 — concurrency + throughput load test for the home gateway.
 *
 * Exercises the serving path and the docs/migration-go-no-go-plan.md §T9 pass criteria:
 *   1. Hot-path model holds >= 30 tok/s (the qwen3-coder-next "Strix flip" target + mellum bulk).
 *   2. p50 TTFT <= 2s, p95 <= 8s at the target concurrency (N=4 co-op users).
 *   3. Owner-preempts-guest admission fires (admission.ts): at cap, a guest gets an immediate
 *      503 Retry-After while the owner is queued (ownerQueueMaxMs) and served next.
 *   4. quota.ts enforcement: a low-RPM key gets 429 + Retry-After + X-RateLimit-* headers.
 *   5. /metrics (owner/monitor) exposes inflight gauge, TTFT histogram, admission/ratelimit counters.
 *
 * Dep-free (node fetch + manual SSE parse). Keys are read from files so they never hit argv/env dumps.
 * Run ON the box (pure serving latency, no laptop->box hop):
 *   BASE_URL=http://192.0.2.10:8080 KEY_DIR=/tmp/gatec node scripts/gate-c-loadtest.mjs
 * Env: MODEL (mellum), HEAVY_MODEL (qwen3-coder-next-80b), CONC (4), ROUNDS (6), SOAK_S (0).
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const BASE = (process.env.BASE_URL ?? "http://192.0.2.10:8080").replace(/\/$/, "");
const KEY_DIR = process.env.KEY_DIR ?? "/tmp/gatec";
const MODEL = process.env.MODEL ?? "mellum";
const HEAVY = process.env.HEAVY_MODEL ?? "qwen3-coder-next-80b";
const CONC = Number(process.env.CONC ?? 4);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const SOAK_S = Number(process.env.SOAK_S ?? 0);
const HOG = Number(process.env.HOG_TOKENS ?? 512); // slot-occupier length for the preemption test
const ONLY = process.env.PHASE ?? ""; // run a single phase (e.g. "3"); empty = all

const readKey = (n) => readFileSync(`${KEY_DIR}/${n}`, "utf8").trim();
const GUEST = readKey("c1.key"); // tier guest, maxParallel 4
const OWNER = readKey("c2.key"); // tier owner, maxParallel 2
const QUOTA = readKey("c3.key"); // tier guest, rpm 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  // Nearest-rank: the p-th percentile is the ceil(p/100 * n)-th smallest (1-indexed).
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(s.length - 1, idx))];
};

/** One streaming chat completion. Returns {status, ttftMs, totalMs, tokens, tps, retryAfter, body}. */
async function stream(key, model, prompt, maxTokens) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true, max_tokens: maxTokens, temperature: 0 }),
    });
  } catch (e) {
    return { status: 0, error: String(e), totalMs: performance.now() - t0 };
  }
  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    return { status: res.status, retryAfter: res.headers.get("retry-after"), rlRemaining: res.headers.get("x-ratelimit-remaining"), totalMs: performance.now() - t0, body: body.slice(0, 160) };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", ttftMs = null, tokens = null, chars = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      let j;
      try { j = JSON.parse(d); } catch { continue; }
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) { if (ttftMs === null) ttftMs = performance.now() - t0; chars += delta.length; }
      if (j.usage) tokens = j.usage.completion_tokens;
    }
  }
  const totalMs = performance.now() - t0;
  const genMs = ttftMs !== null ? totalMs - ttftMs : totalMs;
  const ntok = tokens ?? Math.round(chars / 4);
  const tps = genMs > 0 ? (ntok / genMs) * 1000 : 0;
  return { status: 200, ttftMs, totalMs, tokens: ntok, tps };
}

async function phase1Throughput() {
  console.log(`\n## Phase 1 — throughput (tok/s), warm then measure`);
  for (const m of [MODEL, HEAVY]) {
    process.stdout.write(`  warming ${m}... `);
    const w = await stream(GUEST, m, "Say hello in one short sentence.", 16);
    console.log(w.status === 200 ? `ok (${Math.round(w.totalMs)}ms)` : `status ${w.status} ${w.body ?? w.error ?? ""}`);
    const r = await stream(GUEST, m, "Write a short paragraph (about 120 words) describing a sunrise over the sea.", 200);
    if (r.status === 200) console.log(`  ${m.padEnd(22)} ${r.tokens} tok in ${Math.round(r.totalMs)}ms (ttft ${Math.round(r.ttftMs)}ms) → ${r.tps.toFixed(1)} tok/s ${r.tps >= 30 ? "✅≥30" : "⚠️<30"}`);
    else console.log(`  ${m.padEnd(22)} FAILED status ${r.status} ${r.body ?? r.error ?? ""}`);
  }
}

async function phase2Concurrency() {
  console.log(`\n## Phase 2 — TTFT under N=${CONC} concurrency on ${MODEL}, ${ROUNDS} rounds`);
  const ttfts = [], totals = [];
  let served = 0, busy = 0, other = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const tasks = Array.from({ length: CONC }, (_, k) =>
      stream(GUEST, MODEL, `Round ${round} req ${k}: list three primary colors.`, 48)
    );
    const rs = await Promise.all(tasks);
    for (const r of rs) {
      if (r.status === 200) { served++; if (r.ttftMs != null) ttfts.push(r.ttftMs); totals.push(r.totalMs); }
      else if (r.status === 503) busy++;
      else other++;
    }
    process.stdout.write(`  round ${round + 1}/${ROUNDS}: ${rs.filter((r) => r.status === 200).length} served, ${rs.filter((r) => r.status === 503).length} busy(503)\r`);
  }
  console.log("");
  const p50 = pct(ttfts, 50), p95 = pct(ttfts, 95);
  console.log(`  outcomes: ${served} served, ${busy} busy-503 (admission), ${other} other`);
  if (!ttfts.length) console.log(`  TTFT: no served requests (all admission-rejected?) — cannot measure`);
  else console.log(`  TTFT (served, n=${ttfts.length}): p50 ${Math.round(p50)}ms ${p50 <= 2000 ? "✅≤2s" : "⚠️>2s"}, p95 ${Math.round(p95)}ms ${p95 <= 8000 ? "✅≤8s" : "⚠️>8s"}, max ${Math.round(Math.max(...ttfts))}ms`);
  console.log(`  total latency (served): p50 ${Math.round(pct(totals, 50))}ms, p95 ${Math.round(pct(totals, 95))}ms`);
  return { p50, p95, served, busy };
}

async function phase3OwnerPreempt() {
  console.log(`\n## Phase 3 — owner-preempts-guest admission`);
  // Saturate both slots with long guest requests (kept in flight), then fire owner+guest together.
  const hogs = [stream(GUEST, MODEL, "Write a detailed essay about the ocean.", HOG), stream(GUEST, MODEL, "Write a detailed essay about mountains.", HOG)];
  await sleep(500); // let the two hogs occupy the slots
  const t = performance.now();
  const [owner, guest] = await Promise.all([
    stream(OWNER, MODEL, "owner: quick — name one color.", 16),
    stream(GUEST, MODEL, "guest: quick — name one color.", 16),
  ]);
  const dt = (r) => (r.status === 200 ? `200 served in ${Math.round(r.totalMs)}ms` : `${r.status} retry-after=${r.retryAfter ?? "—"}`);
  console.log(`  while 2 slots busy: OWNER → ${dt(owner)} | GUEST → ${dt(guest)}`);
  const preemptFired = owner.status === 200 && guest.status === 503; // owner got served (queued), guest rejected
  const partialEvidence = owner.status === 200 || guest.status === 503;
  console.log(`  owner-preference verified: ${preemptFired ? "✅ YES (owner queued+served, guest 503)" : partialEvidence ? "🟡 partial (see above)" : "⚠️ not observed"}`);
  await Promise.all(hogs).catch(() => {}); // drain
  return { preemptFired, owner: owner.status, guest: guest.status };
}

async function phase4Quota() {
  console.log(`\n## Phase 4 — quota 429 (key rpm=2), fire 5 sequential`);
  let ok = 0, rl = 0; let firstRetry = null, firstRemaining = null;
  for (let i = 0; i < 5; i++) {
    const r = await stream(QUOTA, MODEL, `quota probe ${i}: hi`, 8);
    if (r.status === 200) ok++;
    else if (r.status === 429) { rl++; if (firstRetry === null) { firstRetry = r.retryAfter; firstRemaining = r.rlRemaining; } }
    process.stdout.write(`  req ${i + 1}: ${r.status}${r.status === 429 ? ` (retry-after=${r.retryAfter}, remaining=${r.rlRemaining})` : ""}  `);
  }
  console.log("");
  console.log(`  ${ok} ok, ${rl} rate-limited(429); first 429 retry-after=${firstRetry} x-ratelimit-remaining=${firstRemaining} ${rl > 0 ? "✅ quota fires" : "⚠️ no 429"}`);
  return { ok, rl };
}

async function phase5Metrics() {
  console.log(`\n## Phase 5 — /metrics (owner) snapshot`);
  const res = await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${OWNER}` } });
  if (res.status !== 200) { console.log(`  /metrics status ${res.status} (need owner/monitor)`); return; }
  const txt = await res.text();
  const grab = (re) => txt.split("\n").filter((l) => re.test(l) && !l.startsWith("#")).slice(0, 6);
  for (const re of [/^homeserver_inflight_requests/, /^homeserver_admission_rejections_total/, /^homeserver_rate_limited_total/, /^homeserver_requests_total/, /^homeserver_ttft_seconds_(count|sum)/]) {
    grab(re).forEach((l) => console.log(`  ${l}`));
  }
}

async function soak() {
  if (SOAK_S <= 0) return;
  const progressS = Number(process.env.PROGRESS_S ?? 60);
  const startMs = performance.now();
  const end = startMs + SOAK_S * 1000;
  console.log(`\n## Soak — ${SOAK_S}s continuous on ${HEAVY}, progress every ${progressS}s`);
  const samples = [];
  let reqs = 0, fails = 0, lastLog = startMs;
  while (performance.now() < end) {
    const r = await stream(GUEST, HEAVY, "Write one sentence about the weather.", 64);
    reqs++;
    if (r.status === 200 && r.ttftMs != null) samples.push(r.tps);
    else fails++;
    const now = performance.now();
    if (now - lastLog >= progressS * 1000) {
      lastLog = now;
      const recent = samples.slice(-200); // last ~200 samples = a moving window
      const mn = recent.length ? Math.min(...recent).toFixed(1) : "—";
      console.log(`  [+${((now - startMs) / 60000).toFixed(1)}m] ${reqs} reqs, ${fails} fail; tok/s p50 ${pct(recent, 50).toFixed(1)} min ${mn} (last ${recent.length})`);
    }
  }
  const mn = samples.length ? Math.min(...samples) : 0;
  console.log(`\n  SOAK DONE: ${reqs} reqs, ${fails} fail over ${SOAK_S}s; tok/s p50 ${pct(samples, 50).toFixed(1)}, p05 ${pct(samples, 5).toFixed(1)}, min ${mn.toFixed(1)} ${samples.length && mn >= 30 ? "✅ holds ≥30" : "⚠️ check"}`);
}

async function main() {
  console.log(`Gate C / T9 load test — ${BASE} (model=${MODEL}, heavy=${HEAVY}, N=${CONC}, rounds=${ROUNDS}${ONLY ? `, PHASE=${ONLY}` : ""})`);
  const run = (n) => !ONLY || ONLY === String(n);
  if (run(1)) await phase1Throughput();
  const c = run(2) ? await phase2Concurrency() : null;
  const p = run(3) ? await phase3OwnerPreempt() : null;
  const q = run(4) ? await phase4Quota() : null;
  if (run(5)) await phase5Metrics();
  if (run(6)) await soak();
  if (ONLY) return;
  console.log(`\n## Gate C verdict (proposed criteria)`);
  console.log(`  • TTFT p50≤2s & p95≤8s @N=${CONC}: ${c.p50 <= 2000 && c.p95 <= 8000 ? "✅ PASS" : "⚠️ review"} (p50 ${Math.round(c.p50)}ms / p95 ${Math.round(c.p95)}ms)`);
  console.log(`  • owner preemption fires:        ${p.preemptFired ? "✅ PASS" : "🟡 see Phase 3"}`);
  console.log(`  • quota 429 enforced:            ${q.rl > 0 ? "✅ PASS" : "⚠️"}`);
  console.log(`  • throughput ≥30 tok/s:          see Phase 1 (and Soak if SOAK_S>0; 4h soak = separate run)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
