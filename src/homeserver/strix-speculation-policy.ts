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
  pairedRepetitions: number;
  minimumRepetitionUsefulWorkRatio: number | null;
  repetitionUsefulWorkRatios: number[];
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
  const scalarFlags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const next = (): string => {
      const value = nextValue(argv, index, flag);
      index++;
      return value;
    };
    if (flag !== "--candidate") {
      if (scalarFlags.has(flag)) throw new Error(`duplicate argument: ${flag}`);
      scalarFlags.add(flag);
    }
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

interface PolicyBatch {
  fixtureId: string;
  taskType: string;
  concurrency: number;
  repetition: number;
  wallMs: number;
  speculation: {
    draftTokens: number;
    acceptedTokens: number;
    verificationSteps: number;
    acceptanceRate: number | null;
  } | null;
  requests: Array<{ ok: boolean; oraclePass: boolean; outputSha256: string | null }>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string, allowZero = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} finite number`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function parsePolicyBatches(raw: unknown, label: string): Map<string, PolicyBatch[]> {
  const root = object(raw, label);
  const values = root["batches"];
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label}.batches must be a non-empty array`);
  const grouped = new Map<string, PolicyBatch[]>();
  const fullKeys = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const row = object(values[index], `${label}.batches[${index}]`);
    const fixtureId = row["fixtureId"];
    const taskType = row["taskType"];
    if (typeof fixtureId !== "string" || fixtureId.length === 0) throw new Error(`${label}.batches[${index}].fixtureId is invalid`);
    if (typeof taskType !== "string" || taskType.length === 0) throw new Error(`${label}.batches[${index}].taskType is invalid`);
    const concurrency = integer(row["concurrency"], `${label}.batches[${index}].concurrency`);
    const repetition = integer(row["repetition"], `${label}.batches[${index}].repetition`);
    const wallMs = finiteNumber(row["wallMs"], `${label}.batches[${index}].wallMs`, false);
    const rawRequests = row["requests"];
    if (!Array.isArray(rawRequests)) throw new Error(`${label}.batches[${index}].requests must be an array`);
    const requests = rawRequests.map((rawRequest, requestIndex) => {
      const request = object(rawRequest, `${label}.batches[${index}].requests[${requestIndex}]`);
      if (typeof request["ok"] !== "boolean" || typeof request["oraclePass"] !== "boolean") {
        throw new Error(`${label}.batches[${index}].requests[${requestIndex}] must contain boolean ok/oraclePass`);
      }
      const outputSha256 = request["outputSha256"];
      if (outputSha256 !== null && (typeof outputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(outputSha256))) {
        throw new Error(`${label}.batches[${index}].requests[${requestIndex}].outputSha256 must be a lowercase SHA-256 or null`);
      }
      return { ok: request["ok"], oraclePass: request["oraclePass"], outputSha256 };
    });
    let speculation: PolicyBatch["speculation"] = null;
    if (row["speculation"] !== null) {
      const spec = object(row["speculation"], `${label}.batches[${index}].speculation`);
      const acceptanceRate = spec["acceptanceRate"];
      if (acceptanceRate !== null && (typeof acceptanceRate !== "number" || !Number.isFinite(acceptanceRate))) {
        throw new Error(`${label}.batches[${index}].speculation.acceptanceRate must be finite or null`);
      }
      speculation = {
        draftTokens: integer(spec["draftTokens"], `${label}.batches[${index}].speculation.draftTokens`),
        acceptedTokens: integer(spec["acceptedTokens"], `${label}.batches[${index}].speculation.acceptedTokens`),
        verificationSteps: integer(spec["verificationSteps"], `${label}.batches[${index}].speculation.verificationSteps`),
        acceptanceRate,
      };
    }
    const batch = { fixtureId, taskType, concurrency, repetition, wallMs, speculation, requests };
    const key = cellKey(batch);
    const fullKey = `${key}\u0000${repetition}`;
    if (fullKeys.has(fullKey)) throw new Error(`${label} contains a duplicate repetition batch: ${fixtureId}/${taskType}/n=${concurrency}/r=${repetition}`);
    fullKeys.add(fullKey);
    grouped.set(key, [...(grouped.get(key) ?? []), batch]);
  }
  for (const batches of grouped.values()) batches.sort((left, right) => left.repetition - right.repetition);
  return grouped;
}

function assertNoExtraBatchCells(report: StrixComparableServerReport, groups: Map<string, PolicyBatch[]>, label: string): void {
  const expected = new Set(report.summaries.map((summary) => cellKey(summary)));
  for (const [key, batches] of groups) {
    if (expected.has(key)) continue;
    const batch = batches[0]!;
    throw new Error(`${label} contains a raw batch cell without a matching summary: ${batch.fixtureId}/${batch.taskType}/n=${batch.concurrency}`);
  }
}

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

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function batchEvidenceIssue(summary: Summary, batches: PolicyBatch[] | undefined, requireSpeculation: boolean): string | null {
  if (batches === undefined) return "raw repetition batches are missing";
  if (batches.length !== summary.batches) return `raw batch count ${batches.length} does not match summary ${summary.batches}`;
  let successful = 0;
  let oraclePasses = 0;
  let wallMs = 0;
  let draftTokens = 0;
  let acceptedTokens = 0;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!;
    if (batch.repetition !== index) return `repetition indices must be contiguous from zero; observed ${batch.repetition} at index ${index}`;
    if (batch.requests.length !== summary.concurrency) return `repetition ${batch.repetition} request count must equal concurrency ${summary.concurrency}`;
    for (let requestIndex = 0; requestIndex < batch.requests.length; requestIndex++) {
      const request = batch.requests[requestIndex]!;
      if (request.oraclePass && !request.ok) return `repetition ${batch.repetition} contains an oracle pass for an unsuccessful request`;
      if (request.ok && request.outputSha256 === null) {
        return `repetition ${batch.repetition} request ${requestIndex} is successful but has no output hash`;
      }
      if (request.ok) successful++;
      if (request.oraclePass) oraclePasses++;
    }
    wallMs += batch.wallMs;
    if (batch.speculation !== null) {
      const spec = batch.speculation;
      if (!requireSpeculation &&
          (spec.draftTokens > 0 || spec.acceptedTokens > 0 || spec.verificationSteps > 0 || spec.acceptanceRate !== null)) {
        return `repetition ${batch.repetition} direct control recorded speculative activity`;
      }
      if (spec.acceptedTokens > spec.draftTokens) return `repetition ${batch.repetition} accepted tokens exceed drafted tokens`;
      const expectedAcceptance = spec.draftTokens === 0 ? null : spec.acceptedTokens / spec.draftTokens;
      if (expectedAcceptance === null ? spec.acceptanceRate !== null : spec.acceptanceRate === null || !closeEnough(spec.acceptanceRate, expectedAcceptance)) {
        return `repetition ${batch.repetition} draft acceptance does not match accepted/drafted tokens`;
      }
      draftTokens += spec.draftTokens;
      acceptedTokens += spec.acceptedTokens;
    }
    if (requireSpeculation && (batch.speculation === null || batch.speculation.draftTokens === 0 || batch.speculation.acceptanceRate === null)) {
      return `repetition ${batch.repetition} draft acceptance was not observable`;
    }
  }
  if (successful !== summary.successfulRequests || oraclePasses !== summary.oraclePasses) {
    return `raw success/oracle counts ${successful}/${oraclePasses} do not match summary ${summary.successfulRequests}/${summary.oraclePasses}`;
  }
  const useful = oraclePasses / (wallMs / 60_000);
  if (!closeEnough(useful, summary.usefulCompletionsPerMinute)) return `raw useful completions/minute ${useful} does not match summary ${summary.usefulCompletionsPerMinute}`;
  const aggregateAcceptance = draftTokens === 0 ? null : acceptedTokens / draftTokens;
  if (aggregateAcceptance === null ? summary.acceptanceRate !== null : summary.acceptanceRate === null || !closeEnough(aggregateAcceptance, summary.acceptanceRate)) {
    return "raw aggregate draft acceptance does not match summary";
  }
  return null;
}

function repetitionRatios(direct: PolicyBatch[], candidate: PolicyBatch[]): { ratios: number[]; issue: string | null } {
  const ratios: number[] = [];
  for (let index = 0; index < direct.length; index++) {
    const control = direct[index]!;
    const arm = candidate[index]!;
    const controlSuccessful = control.requests.filter((request) => request.ok).length;
    const candidateSuccessful = arm.requests.filter((request) => request.ok).length;
    const controlPasses = control.requests.filter((request) => request.oraclePass).length;
    const candidatePasses = arm.requests.filter((request) => request.oraclePass).length;
    if (candidateSuccessful < controlSuccessful || candidatePasses < controlPasses) {
      return { ratios, issue: `repetition ${index} quality was inferior to direct` };
    }
    for (let requestIndex = 0; requestIndex < control.requests.length; requestIndex++) {
      const controlHash = control.requests[requestIndex]!.outputSha256;
      const candidateHash = arm.requests[requestIndex]!.outputSha256;
      if (controlHash !== candidateHash) {
        return { ratios, issue: `repetition ${index} request ${requestIndex} output hash differed from direct` };
      }
    }
    const controlUseful = controlPasses / (control.wallMs / 60_000);
    const candidateUseful = candidatePasses / (arm.wallMs / 60_000);
    if (controlUseful === 0) return { ratios, issue: `repetition ${index} direct useful work was zero, so stability is unobservable` };
    const ratio = candidateUseful / controlUseful;
    ratios.push(ratio);
    if (ratio < 1 && !closeEnough(ratio, 1)) return { ratios, issue: `repetition ${index} was slower than direct (${ratio.toFixed(3)}x useful work)` };
  }
  return { ratios, issue: null };
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
  const directBatchGroups = parsePolicyBatches(rawDirect, "direct");
  const candidateBatchGroups = rawCandidates.map((raw, index) => parsePolicyBatches(raw, `candidate[${index}]`));
  assertNoExtraBatchCells(direct, directBatchGroups, "direct");
  for (let index = 0; index < candidates.length; index++) {
    assertNoExtraBatchCells(candidates[index]!, candidateBatchGroups[index]!, `candidate[${index}]`);
  }
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
      repetitionUsefulWorkRatios: number[];
    }> = [];

    const directBatches = directBatchGroups.get(key);
    const directIssue = summaryEvidenceIssue(directSummary, minimumBatches) ?? batchEvidenceIssue(directSummary, directBatches, false);
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
        pairedRepetitions: directBatches?.length ?? 0,
        minimumRepetitionUsefulWorkRatio: null,
        repetitionUsefulWorkRatios: [],
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
      const candidateBatches = candidateBatchGroups[index]!.get(key);
      const evidenceIssue = summaryEvidenceIssue(summary, minimumBatches, directSummary) ?? batchEvidenceIssue(summary, candidateBatches, true);
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
      const stability = repetitionRatios(directBatches!, candidateBatches!);
      if (stability.issue !== null) {
        rejections.push(`${label}: ${stability.issue}`);
        continue;
      }
      eligible.push({
        candidate,
        summary,
        usefulWorkRatio: comparison.usefulWorkRatio,
        acceptanceRate: summary.acceptanceRate,
        repetitionUsefulWorkRatios: stability.ratios,
      });
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
        pairedRepetitions: directBatches!.length,
        minimumRepetitionUsefulWorkRatio: null,
        repetitionUsefulWorkRatios: [],
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
      pairedRepetitions: winner.repetitionUsefulWorkRatios.length,
      minimumRepetitionUsefulWorkRatio: Math.min(...winner.repetitionUsefulWorkRatios),
      repetitionUsefulWorkRatios: winner.repetitionUsefulWorkRatios,
      usefulWorkRatio: winner.usefulWorkRatio,
      acceptanceRate: winner.acceptanceRate,
      reason: "highest aggregate useful completions/minute among exact-output-equivalent, quality-non-inferior arms with no slower paired repetition",
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
      "Raw repetition batches are paired exactly; no selected speculative arm may change a greedy output hash, lose successful/oracle-passing requests, or lose useful completions/minute in any repetition.",
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
    "| Fixture | Task | N | Evidence | Selection | Method | Depth | Batches / requests | Aggregate useful ratio | Min repetition ratio | Acceptance | Reason |",
    "|---|---|---:|:---:|---|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const cell of policy.cells) {
    lines.push(`| ${cell.fixtureId} | ${cell.taskType} | ${cell.concurrency} | ${cell.evidenceSufficient ? "sufficient" : "insufficient"} | ${cell.selection} | ${cell.speculation} | ${cell.draftDepth ?? "n/a"} | ${cell.selectedBatches} / ${cell.selectedRequests} | ${cell.usefulWorkRatio.toFixed(3)} | ${cell.minimumRepetitionUsefulWorkRatio === null ? "n/a" : cell.minimumRepetitionUsefulWorkRatio.toFixed(3)} | ${cell.acceptanceRate === null ? "n/a" : `${(cell.acceptanceRate * 100).toFixed(1)}%`} | ${cell.reason} |`);
  }
  lines.push("", "## Limits", "", ...policy.limitations.map((limit) => `- ${limit}`));
  return `${lines.join("\n")}\n`;
}
