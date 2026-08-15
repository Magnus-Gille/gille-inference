import {
  compareStrixServerReports,
  validateComparableServerReport,
  type StrixComparableServerReport,
} from "./strix-benchmark-comparison.js";

export interface StrixSpeculationPolicyArgs {
  directPath: string;
  candidatePaths: string[];
  minimumUsefulWorkGain: number;
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

export function parseStrixSpeculationPolicyArgs(argv: string[]): StrixSpeculationPolicyArgs {
  let directPath: string | null = null;
  const candidatePaths: string[] = [];
  let minimumUsefulWorkGain = 0.03;
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
    else if (flag === "--out") outPrefix = next();
    else throw new Error(`unrecognized argument: ${flag}`);
  }
  if (directPath === null) throw new Error("--direct is required");
  if (candidatePaths.length === 0) throw new Error("at least one --candidate is required");
  if (candidatePaths.some((path) => path === directPath) || new Set(candidatePaths).size !== candidatePaths.length) {
    throw new Error("direct and candidate paths must be distinct");
  }
  if (outPrefix === null || outPrefix.trim() === "") throw new Error("--out is required");
  return { directPath, candidatePaths, minimumUsefulWorkGain, outPrefix };
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

export function synthesizeStrixSpeculationPolicy(
  rawDirect: unknown,
  rawCandidates: unknown[],
  minimumUsefulWorkGain = 0.03,
): StrixSpeculationPolicy {
  if (!Number.isFinite(minimumUsefulWorkGain) || minimumUsefulWorkGain < 0 || minimumUsefulWorkGain > 1) {
    throw new Error("minimumUsefulWorkGain must be between 0 and 1");
  }
  if (rawCandidates.length === 0) throw new Error("at least one speculative candidate is required");

  const direct = validateComparableServerReport(rawDirect, "direct");
  assertDirect(direct);
  const candidates = rawCandidates.map((raw, index) => {
    const report = validateComparableServerReport(raw, `candidate[${index}]`);
    assertSpeculative(report, index);
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
      usefulWorkRatio: number;
      acceptanceRate: number;
    }> = [];

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const summary = summariesByCandidate[index]!.get(key)!;
      const comparison = comparisonRowsByCandidate[index]!.get(key)!;
      const label = `${candidate.provenance.speculation} depth ${candidate.provenance.draftDepth}`;
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
      eligible.push({ candidate, usefulWorkRatio: comparison.usefulWorkRatio, acceptanceRate: summary.acceptanceRate });
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
    directServerArgsSha256: direct.provenance.serverArgsSha256,
    candidateServerArgsSha256: candidates.map((candidate) => candidate.provenance.serverArgsSha256),
    cells,
    limitations: [
      "This is an offline policy synthesized from repeated benchmark summaries, not an online rolling controller.",
      "A speculative arm is selected only when quality is non-inferior, acceptance is observable, and useful completions/minute clears the explicit margin.",
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
    "",
    "| Fixture | Task | N | Selection | Method | Depth | Useful-work ratio | Acceptance | Reason |",
    "|---|---|---:|---|---|---:|---:|---:|---|",
  ];
  for (const cell of policy.cells) {
    lines.push(`| ${cell.fixtureId} | ${cell.taskType} | ${cell.concurrency} | ${cell.selection} | ${cell.speculation} | ${cell.draftDepth ?? "n/a"} | ${cell.usefulWorkRatio.toFixed(3)} | ${cell.acceptanceRate === null ? "n/a" : `${(cell.acceptanceRate * 100).toFixed(1)}%`} | ${cell.reason} |`);
  }
  lines.push("", "## Limits", "", ...policy.limitations.map((limit) => `- ${limit}`));
  return `${lines.join("\n")}\n`;
}
