import {
  compareStrixServerReports,
  validateComparableServerReport,
  type StrixComparableServerReport,
} from "./strix-benchmark-comparison.js";

export interface StrixSpeculationPolicyArgs {
  directPath: string;
  candidatePaths: string[];
  minimumUsefulWorkGain: number;
  minimumBatches: number;
  outPrefix: string;
}

export interface StrixSpeculationPolicyCell {
  fixtureId: string;
  taskType: string;
  concurrency: number;
  selection: "direct" | "speculative";
  speculation: string;
  draftDepth: number | null;
  serverArgsSha256: string;
  evidenceSufficient: boolean;
  directBatches: number;
  directRequests: number;
  selectedBatches: number;
  selectedRequests: number;
  usefulWorkRatio: number;
  acceptanceRate: number | null;
  reason: string;
  rejections: string[];
}

export interface StrixSpeculationPolicy {
  schemaVersion: 1;
  model: string;
  fixtureSha256: string;
  minimumUsefulWorkGain: number;
  minimumBatches: number;
  directServerArgsSha256: string;
  candidateServerArgsSha256: string[];
  cells: StrixSpeculationPolicyCell[];
  limitations: string[];
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function percentage(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--min-gain-percent must be between 0 and 100");
  }
  return parsed / 100;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export function parseStrixSpeculationPolicyArgs(argv: string[]): StrixSpeculationPolicyArgs {
  let directPath: string | null = null;
  const candidatePaths: string[] = [];
  let minimumUsefulWorkGain = 0.03;
  let minimumBatches = 3;
  let outPrefix: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const next = (): string => {
      const value = nextValue(argv, index, flag);
      index++;
      return value;
    };
    if (flag === "--direct") directPath = next();
    else if (flag === "--candidate") candidatePaths.push(next());
    else if (flag === "--min-gain-percent") minimumUsefulWorkGain = percentage(next());
    else if (flag === "--min-batches") minimumBatches = positiveInteger(next(), flag);
    else if (flag === "--out") outPrefix = next();
    else throw new Error(`unrecognized argument: ${flag}`);
  }
  if (directPath === null) throw new Error("--direct is required");
  if (candidatePaths.length === 0) throw new Error("at least one --candidate is required");
  if (candidatePaths.some((path) => path === directPath) || new Set(candidatePaths).size !== candidatePaths.length) {
    throw new Error("direct and candidate paths must be distinct");
  }
  if (outPrefix === null || outPrefix.trim() === "") throw new Error("--out is required");
  return { directPath, candidatePaths, minimumUsefulWorkGain, minimumBatches, outPrefix };
}

function cellKey(cell: { fixtureId: string; taskType: string; concurrency: number }): string {
  return `${cell.fixtureId}\u0000${cell.taskType}\u0000${cell.concurrency}`;
}

function assertDirect(report: StrixComparableServerReport): void {
  if (report.provenance.speculation !== "none" || report.provenance.draftDepth !== null) {
    throw new Error("direct control must use speculation=none and draftDepth=null");
  }
}

function assertSpeculative(report: StrixComparableServerReport, index: number): void {
  if (report.provenance.speculation === "none" || report.provenance.draftDepth === null) {
    throw new Error(`candidate[${index}] must enable speculation with a positive draft depth`);
  }
}

function assertUniqueCells(report: StrixComparableServerReport, label: string): void {
  const seen = new Set<string>();
  for (const summary of report.summaries) {
    const key = cellKey(summary);
    if (seen.has(key)) throw new Error(`${label} contains a duplicate workload cell: ${summary.fixtureId}/${summary.taskType}/n=${summary.concurrency}`);
    seen.add(key);
  }
}

type Summary = StrixComparableServerReport["summaries"][number];

function countRateIssue(summary: Summary, count: number, rate: number, label: string): string | null {
  if (!Number.isSafeInteger(count) || count < 0 || count > summary.requests) {
    return `${label} count must be an integer between 0 and requests`;
  }
  if (rate < 0 || rate > 1) return `${label} rate must be between 0 and 1`;
  const expected = summary.requests === 0 ? 0 : count / summary.requests;
  return Math.abs(rate - expected) <= 1e-9 ? null : `${label} rate does not match its count and requests`;
}

function summaryEvidenceIssue(summary: Summary, minimumBatches: number, direct?: Summary): string | null {
  if (!Number.isSafeInteger(summary.concurrency) || summary.concurrency <= 0) return "concurrency must be a positive integer";
  if (!Number.isSafeInteger(summary.batches) || summary.batches < minimumBatches) {
    return `requires minimum ${minimumBatches} batches; observed ${summary.batches}`;
  }
  if (!Number.isSafeInteger(summary.requests) || summary.requests !== summary.batches * summary.concurrency) {
    return `requests must equal batches × concurrency (${summary.batches} × ${summary.concurrency})`;
  }
  const successIssue = countRateIssue(summary, summary.successfulRequests, summary.successRate, "success");
  if (successIssue !== null) return successIssue;
  const oracleIssue = countRateIssue(summary, summary.oraclePasses, summary.oraclePassRate, "oracle-pass");
  if (oracleIssue !== null) return oracleIssue;
  if (summary.oraclePasses > summary.successfulRequests) return "oracle passes cannot exceed successful requests";
  if (summary.acceptanceRate !== null && (summary.acceptanceRate < 0 || summary.acceptanceRate > 1)) {
    return "draft acceptance must be between 0 and 1";
  }
  if (direct !== undefined && (summary.batches !== direct.batches || summary.requests !== direct.requests)) {
    return `requires balanced exposure with direct (${direct.batches} batches/${direct.requests} requests); observed ${summary.batches}/${summary.requests}`;
  }
  return null;
}

export function synthesizeStrixSpeculationPolicy(
  rawDirect: unknown,
  rawCandidates: unknown[],
  minimumUsefulWorkGain = 0.03,
  minimumBatches = 3,
): StrixSpeculationPolicy {
  if (!Number.isFinite(minimumUsefulWorkGain) || minimumUsefulWorkGain < 0 || minimumUsefulWorkGain > 1) {
    throw new Error("minimumUsefulWorkGain must be between 0 and 1");
  }
  if (rawCandidates.length === 0) throw new Error("at least one speculative candidate is required");
  if (!Number.isSafeInteger(minimumBatches) || minimumBatches <= 0) throw new Error("minimumBatches must be a positive integer");

  const direct = validateComparableServerReport(rawDirect, "direct");
  assertDirect(direct);
  assertUniqueCells(direct, "direct");
  const candidates = rawCandidates.map((raw, index) => {
    const report = validateComparableServerReport(raw, `candidate[${index}]`);
    assertSpeculative(report, index);
    assertUniqueCells(report, `candidate[${index}]`);
    return report;
  });
  const comparisons = rawCandidates.map((candidate) => compareStrixServerReports(rawDirect, candidate, "speculation"));
  const summariesByCandidate = candidates.map((candidate) => new Map(candidate.summaries.map((row) => [cellKey(row), row])));
  const comparisonRowsByCandidate = comparisons.map((comparison) => new Map(comparison.rows.map((row) => [cellKey(row), row])));

  const cells = direct.summaries.map((directSummary): StrixSpeculationPolicyCell => {
    const key = cellKey(directSummary);
    const rejections: string[] = [];
    const eligible: Array<{
      candidate: StrixComparableServerReport;
      summary: Summary;
      usefulWorkRatio: number;
      acceptanceRate: number;
    }> = [];

    const directIssue = summaryEvidenceIssue(directSummary, minimumBatches);
    if (directIssue !== null) {
      return {
        fixtureId: directSummary.fixtureId,
        taskType: directSummary.taskType,
        concurrency: directSummary.concurrency,
        selection: "direct",
        speculation: "none",
        draftDepth: null,
        serverArgsSha256: direct.provenance.serverArgsSha256,
        evidenceSufficient: false,
        directBatches: directSummary.batches,
        directRequests: directSummary.requests,
        selectedBatches: directSummary.batches,
        selectedRequests: directSummary.requests,
        usefulWorkRatio: 1,
        acceptanceRate: null,
        reason: `direct evidence is insufficient: ${directIssue}`,
        rejections: [`direct: ${directIssue}`],
      };
    }

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const summary = summariesByCandidate[index]!.get(key)!;
      const comparison = comparisonRowsByCandidate[index]!.get(key)!;
      const label = `${candidate.provenance.speculation} depth ${candidate.provenance.draftDepth}`;
      const evidenceIssue = summaryEvidenceIssue(summary, minimumBatches, directSummary);
      if (evidenceIssue !== null) {
        rejections.push(`${label}: ${evidenceIssue}`);
        continue;
      }
      if (!comparison.qualityNonInferior) {
        rejections.push(`${label}: quality was inferior to direct`);
        continue;
      }
      if (summary.acceptanceRate === null) {
        rejections.push(`${label}: draft acceptance was not observable`);
        continue;
      }
      if (comparison.usefulWorkRatio === null) {
        rejections.push(`${label}: useful-work ratio was not observable`);
        continue;
      }
      if (comparison.usefulWorkRatio <= 1 + minimumUsefulWorkGain) {
        rejections.push(`${label}: did not beat direct by more than ${(minimumUsefulWorkGain * 100).toFixed(1)}%`);
        continue;
      }
      eligible.push({ candidate, summary, usefulWorkRatio: comparison.usefulWorkRatio, acceptanceRate: summary.acceptanceRate });
    }

    eligible.sort((left, right) =>
      right.usefulWorkRatio - left.usefulWorkRatio ||
      left.candidate.provenance.draftDepth! - right.candidate.provenance.draftDepth!);
    const winner = eligible[0];
    if (winner === undefined) {
      return {
        fixtureId: directSummary.fixtureId,
        taskType: directSummary.taskType,
        concurrency: directSummary.concurrency,
        selection: "direct",
        speculation: "none",
        draftDepth: null,
        serverArgsSha256: direct.provenance.serverArgsSha256,
        evidenceSufficient: true,
        directBatches: directSummary.batches,
        directRequests: directSummary.requests,
        selectedBatches: directSummary.batches,
        selectedRequests: directSummary.requests,
        usefulWorkRatio: 1,
        acceptanceRate: null,
        reason: rejections.length === 1 ? rejections[0]! : "no eligible speculative arm beat the direct quality/useful-work gate",
        rejections,
      };
    }
    return {
      fixtureId: directSummary.fixtureId,
      taskType: directSummary.taskType,
      concurrency: directSummary.concurrency,
      selection: "speculative",
      speculation: winner.candidate.provenance.speculation,
      draftDepth: winner.candidate.provenance.draftDepth,
      serverArgsSha256: winner.candidate.provenance.serverArgsSha256,
      evidenceSufficient: true,
      directBatches: directSummary.batches,
      directRequests: directSummary.requests,
      selectedBatches: winner.summary.batches,
      selectedRequests: winner.summary.requests,
      usefulWorkRatio: winner.usefulWorkRatio,
      acceptanceRate: winner.acceptanceRate,
      reason: "highest measured useful completions/minute among quality-non-inferior observable arms",
      rejections,
    };
  });

  return {
    schemaVersion: 1,
    model: direct.model,
    fixtureSha256: direct.fixtureSha256,
    minimumUsefulWorkGain,
    minimumBatches,
    directServerArgsSha256: direct.provenance.serverArgsSha256,
    candidateServerArgsSha256: candidates.map((candidate) => candidate.provenance.serverArgsSha256),
    cells,
    limitations: [
      "This is an offline policy synthesized from repeated benchmark summaries, not an online rolling controller.",
      "A speculative arm is selected only when quality is non-inferior, acceptance is observable, and useful completions/minute clears the explicit margin.",
      "Every selected arm must meet the minimum repeated-batch count, internally consistent counters, and exposure balanced with direct; this is not a confidence interval or an interleaved A/B design.",
      "Unmeasured workload/concurrency cells must use direct decoding; do not extrapolate this policy.",
      "Promotion still requires correctness, long-generation equivalence, soak, memory, and production verification gates.",
    ],
  };
}

export function renderStrixSpeculationPolicyMarkdown(policy: StrixSpeculationPolicy): string {
  const lines = [
    `# Strix speculation policy — ${policy.model}`,
    "",
    `Fixture SHA-256: \`${policy.fixtureSha256}\``,
    `Minimum useful-work gain: ${(policy.minimumUsefulWorkGain * 100).toFixed(1)}%`,
    `Minimum repeated batches per cell: ${policy.minimumBatches}`,
    "",
    "| Fixture | Task | N | Evidence | Selection | Method | Depth | Batches / requests | Useful-work ratio | Acceptance | Reason |",
    "|---|---|---:|:---:|---|---|---:|---:|---:|---:|---|",
  ];
  for (const cell of policy.cells) {
    lines.push(`| ${cell.fixtureId} | ${cell.taskType} | ${cell.concurrency} | ${cell.evidenceSufficient ? "sufficient" : "insufficient"} | ${cell.selection} | ${cell.speculation} | ${cell.draftDepth ?? "n/a"} | ${cell.selectedBatches} / ${cell.selectedRequests} | ${cell.usefulWorkRatio.toFixed(3)} | ${cell.acceptanceRate === null ? "n/a" : `${(cell.acceptanceRate * 100).toFixed(1)}%`} | ${cell.reason} |`);
  }
  lines.push("", "## Limits", "", ...policy.limitations.map((limit) => `- ${limit}`));
  return `${lines.join("\n")}\n`;
}
