/**
 * Concurrent inference benchmark.
 *
 * Tests how throughput degrades with multiple simultaneous users
 * on a single Ollama instance. Validates the linear bandwidth-sharing
 * assumption from the hardware gate eval spec.
 *
 * Usage:
 *   tsx scripts/concurrent-benchmark.ts --model gemma4:26b --users 1,2
 *   tsx scripts/concurrent-benchmark.ts --model gemma4:e2b --users 1,2,4 --rounds 10
 *   tsx scripts/concurrent-benchmark.ts --model gemma4:26b --users 1,2 --host 192.0.2.50
 *
 * Run on Air M4 32GB:
 *   tsx scripts/concurrent-benchmark.ts --model gemma4:26b --users 1,2 --rounds 5
 *   tsx scripts/concurrent-benchmark.ts --model gemma4:e2b --users 1,2,4 --rounds 5
 *
 * Run on Pro M1 16GB:
 *   tsx scripts/concurrent-benchmark.ts --model gemma4:e2b --users 1,2,4 --rounds 5
 *
 * Cross-validate: compare degradation patterns across machines.
 *
 * Output: prints a results table + writes JSON to data/concurrent-benchmark-<timestamp>.json
 */

import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SingleResult {
  userId: number;
  round: number;
  ok: boolean;
  completionTokens: number;
  durationMs: number;
  ttftMs: number;
  tokensPerSecond: number;
  error?: string;
}

interface ConcurrencyResult {
  users: number;
  results: SingleResult[];
  totalDurationMs: number;
  medianTokPerSecPerUser: number;
  totalThroughput: number;
  p95TtftMs: number;
  allOk: boolean;
}

interface BenchmarkReport {
  model: string;
  host: string;
  timestamp: string;
  hardwareInfo: string;
  rounds: number;
  prompts: string[];
  results: ConcurrencyResult[];
  degradationSummary: DegradationSummary[];
}

interface DegradationSummary {
  users: number;
  medianTokPerSecPerUser: number;
  totalThroughput: number;
  perUserDegradation: string;
  totalDegradation: string;
  p95TtftMs: number;
}

// ─── Test prompts ───────────────────────────────────────────────────────────
// Mix of short and medium tasks to simulate realistic concurrent use.

const TEST_PROMPTS = [
  "Write a TypeScript function that implements binary search on a sorted array. Include edge cases.",
  "Explain the differences between process.nextTick, setImmediate, and setTimeout in Node.js. Be concise.",
  "Write a SQL query that finds the top 3 customers by total order value in the last 30 days, including their names and emails.",
  "Review this code and suggest improvements:\n```typescript\nfunction dedupe(arr: any[]) {\n  const seen: any = {};\n  return arr.filter(x => {\n    if (seen[x]) return false;\n    seen[x] = true;\n    return true;\n  });\n}\n```",
  "Write a Python decorator that retries a function up to 3 times with exponential backoff on exception.",
  "Explain CAP theorem in the context of choosing between PostgreSQL and DynamoDB for a user profile service.",
  "Write a bash one-liner that finds all files modified in the last 24 hours that contain the string 'TODO' and prints the filename and line number.",
  "Describe three approaches to rate limiting in a distributed system, with pros and cons of each.",
  "Write a TypeScript type that extracts all keys from a nested object type where the value is a string.",
  "Explain how garbage collection works in V8, focusing on the generational hypothesis and why it matters for Node.js server performance.",
];

// ─── Ollama streaming call ──────────────────────────────────────────────────

async function callOllama(
  host: string,
  model: string,
  prompt: string,
  userId: number,
  round: number
): Promise<SingleResult> {
  const startTime = performance.now();
  let ttftMs = 0;
  let firstTokenReceived = false;

  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a helpful expert software engineer. Be concise." },
          { role: "user", content: prompt },
        ],
        stream: true,
        think: false,
        keep_alive: -1,
        options: { temperature: 0.0, num_predict: 512 },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { userId, round, ok: false, completionTokens: 0, durationMs: 0, ttftMs: 0, tokensPerSecond: 0, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    if (!res.body) {
      return { userId, round, ok: false, completionTokens: 0, durationMs: 0, ttftMs: 0, tokensPerSecond: 0, error: "No response body" };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completionTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
            eval_count?: number;
          };

          if (data.message?.content && !firstTokenReceived) {
            ttftMs = Math.round(performance.now() - startTime);
            firstTokenReceived = true;
          }

          if (data.done) {
            completionTokens = data.eval_count ?? 0;
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    const generationTimeMs = durationMs - ttftMs;
    const tokensPerSecond = generationTimeMs > 0
      ? Math.round((completionTokens / generationTimeMs) * 1000 * 10) / 10
      : 0;

    return { userId, round, ok: true, completionTokens, durationMs, ttftMs, tokensPerSecond };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    return { userId, round, ok: false, completionTokens: 0, durationMs, ttftMs: 0, tokensPerSecond: 0, error: String(err) };
  }
}

// ─── Run one concurrency level ──────────────────────────────────────────────

async function runConcurrencyLevel(
  host: string,
  model: string,
  numUsers: number,
  rounds: number,
  prompts: string[]
): Promise<ConcurrencyResult> {
  const allResults: SingleResult[] = [];
  const levelStart = performance.now();

  for (let round = 0; round < rounds; round++) {
    // Each user gets a different prompt (cycling through the list)
    const userPromises: Promise<SingleResult>[] = [];
    for (let u = 0; u < numUsers; u++) {
      const promptIdx = (round * numUsers + u) % prompts.length;
      userPromises.push(callOllama(host, model, prompts[promptIdx], u, round));
    }

    // All users fire simultaneously
    const roundResults = await Promise.all(userPromises);
    allResults.push(...roundResults);

    // Brief pause between rounds to let Ollama settle
    if (round < rounds - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const totalDurationMs = Math.round(performance.now() - levelStart);

  // Compute stats
  const okResults = allResults.filter((r) => r.ok);
  const tokPerSecValues = okResults.map((r) => r.tokensPerSecond).sort((a, b) => a - b);
  const ttftValues = okResults.map((r) => r.ttftMs).sort((a, b) => a - b);

  const medianTokPerSec = tokPerSecValues.length > 0
    ? tokPerSecValues[Math.floor(tokPerSecValues.length / 2)]
    : 0;

  const totalTokens = okResults.reduce((sum, r) => sum + r.completionTokens, 0);
  const totalGenTime = okResults.reduce((sum, r) => sum + (r.durationMs - r.ttftMs), 0);
  const totalThroughput = totalGenTime > 0
    ? Math.round((totalTokens / totalGenTime) * 1000 * 10) / 10
    : 0;

  const p95Idx = Math.min(Math.floor(ttftValues.length * 0.95), ttftValues.length - 1);
  const p95TtftMs = ttftValues.length > 0 ? ttftValues[p95Idx] : 0;

  return {
    users: numUsers,
    results: allResults,
    totalDurationMs,
    medianTokPerSecPerUser: medianTokPerSec,
    totalThroughput,
    p95TtftMs,
    allOk: allResults.every((r) => r.ok),
  };
}

// ─── Hardware info ──────────────────────────────────────────────────────────

function getHardwareInfo(): string {
  try {
    const chip = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf-8" }).trim();
    const memBytes = execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf-8" }).trim();
    const memGB = Math.round(parseInt(memBytes) / 1024 / 1024 / 1024);
    return `${chip}, ${memGB}GB`;
  } catch {
    return "unknown";
  }
}

// ─── Warm model ─────────────────────────────────────────────────────────────

async function warmModel(host: string, model: string): Promise<void> {
  process.stdout.write(`Warming ${model}... `);
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({ model, messages: [], keep_alive: -1 }),
    });
    if (res.ok) await res.json();
    console.log("done");
  } catch (err) {
    console.log(`failed: ${err}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let model = "gemma4:26b";
  let userLevels = [1, 2];
  let rounds = 5;
  let host = "http://localhost:11434";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model": model = args[++i]; break;
      case "--users": userLevels = args[++i].split(",").map(Number); break;
      case "--rounds": rounds = parseInt(args[++i]); break;
      case "--host": host = args[++i]; break;
    }
  }

  console.log(`Concurrent Inference Benchmark`);
  console.log(`  Model:  ${model}`);
  console.log(`  Users:  ${userLevels.join(", ")}`);
  console.log(`  Rounds: ${rounds} per level`);
  console.log(`  Host:   ${host}`);
  console.log(`  Prompts: ${TEST_PROMPTS.length} (cycling)`);

  const hwInfo = getHardwareInfo();
  console.log(`  Hardware: ${hwInfo}`);
  console.log("");

  // Warm the model
  await warmModel(host, model);
  console.log("");

  // Run each concurrency level
  const results: ConcurrencyResult[] = [];
  let baselineTokPerSec = 0;
  let baselineTotalThroughput = 0;

  for (const numUsers of userLevels) {
    process.stdout.write(`Running ${numUsers} concurrent user(s) × ${rounds} rounds... `);
    const result = await runConcurrencyLevel(host, model, numUsers, rounds, TEST_PROMPTS);
    results.push(result);

    if (numUsers === 1) {
      baselineTokPerSec = result.medianTokPerSecPerUser;
      baselineTotalThroughput = result.totalThroughput;
    }

    console.log(`done (${(result.totalDurationMs / 1000).toFixed(1)}s)`);
  }

  // Print results table
  console.log("");
  console.log("=".repeat(90));
  console.log("RESULTS");
  console.log("=".repeat(90));
  console.log("");
  console.log(
    "| Users | Median tok/s/user | Total tok/s | Per-user degrad. | Total degrad. | p95 TTFT |"
  );
  console.log(
    "|-------|-------------------|-------------|------------------|---------------|----------|"
  );

  const degradationSummary: DegradationSummary[] = [];

  for (const r of results) {
    const perUserDeg = baselineTokPerSec > 0
      ? `${((r.medianTokPerSecPerUser / baselineTokPerSec) * 100).toFixed(0)}%`
      : "baseline";
    const totalDeg = baselineTotalThroughput > 0
      ? `${((r.totalThroughput / baselineTotalThroughput) * 100).toFixed(0)}%`
      : "baseline";

    console.log(
      `| ${String(r.users).padStart(5)} | ${r.medianTokPerSecPerUser.toFixed(1).padStart(17)} | ${r.totalThroughput.toFixed(1).padStart(11)} | ${perUserDeg.padStart(16)} | ${totalDeg.padStart(13)} | ${(r.p95TtftMs / 1000).toFixed(1).padStart(5)}s   |`
    );

    degradationSummary.push({
      users: r.users,
      medianTokPerSecPerUser: r.medianTokPerSecPerUser,
      totalThroughput: r.totalThroughput,
      perUserDegradation: perUserDeg,
      totalDegradation: totalDeg,
      p95TtftMs: r.p95TtftMs,
    });
  }

  console.log("");

  // Eval spec pass/fail
  console.log("-".repeat(90));
  console.log("EVAL SPEC GATE CHECK");
  console.log("-".repeat(90));

  for (const r of results) {
    if (r.users === 1) continue;

    const perUserRatio = baselineTokPerSec > 0 ? r.medianTokPerSecPerUser / baselineTokPerSec : 0;
    const totalRatio = baselineTotalThroughput > 0 ? r.totalThroughput / baselineTotalThroughput : 0;

    if (r.users === 2) {
      const perUserPass = perUserRatio >= 0.50;
      const ttftPass = r.p95TtftMs < 5000;
      console.log(`  2 users: per-user >= 50%: ${perUserPass ? "PASS" : "FAIL"} (${(perUserRatio * 100).toFixed(0)}%)`);
      console.log(`  2 users: p95 TTFT < 5s:   ${ttftPass ? "PASS" : "FAIL"} (${(r.p95TtftMs / 1000).toFixed(1)}s)`);
    }

    if (r.users === 4) {
      const perUserPass = perUserRatio >= 0.30;
      const totalPass = totalRatio >= 0.80;
      const ttftPass = r.p95TtftMs < 10000;
      console.log(`  4 users: per-user >= 30%: ${perUserPass ? "PASS" : "FAIL"} (${(perUserRatio * 100).toFixed(0)}%)`);
      console.log(`  4 users: total >= 80%:    ${totalPass ? "PASS" : "FAIL"} (${(totalRatio * 100).toFixed(0)}%)`);
      console.log(`  4 users: p95 TTFT < 10s:  ${ttftPass ? "PASS" : "FAIL"} (${(r.p95TtftMs / 1000).toFixed(1)}s)`);
    }
  }

  console.log("");

  // Write JSON report
  mkdirSync("data", { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join("data", `concurrent-benchmark-${timestamp}.json`);

  const report: BenchmarkReport = {
    model,
    host,
    timestamp: new Date().toISOString(),
    hardwareInfo: hwInfo,
    rounds,
    prompts: TEST_PROMPTS,
    results,
    degradationSummary,
  };

  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Report written to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
