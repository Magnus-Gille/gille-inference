import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface KvDequantCandidate {
  schemaVersion: number;
  status: string;
  source: {
    upstreamBaseCommit: string;
    upstreamHeadCommit: string;
    patchCommits: string[];
    changedFiles: string[];
    diffStat: { files: number; insertions: number; deletions: number };
  };
  productionRuntime: { commit: string; llamaBenchSha256: string; vulkanLibrarySha256: string };
  candidateRuntime: {
    backportCommit: string;
    sourceArchiveSha256: string;
    llamaBenchSha256: string;
    llamaServerSha256: string;
    backendOpsSha256: string;
    vulkanLibrarySha256: string;
  };
  model: { artifactSha256: string };
  localExperiment: {
    contexts: number[];
    arms: Array<{ id: string; runtime: string; kvK: string; kvV: string }>;
    executionPolicy: string;
    residencyPolicy: string;
  };
  promotionGate: { minimumCycles: number; deploymentStatus: string };
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function loadCandidate(): KvDequantCandidate {
  return JSON.parse(
    readFileSync(resolve("configs/strix-kv-dequant-qwen36.json"), "utf8"),
  ) as KvDequantCandidate;
}

describe("Strix Q8 KV dequantization candidate record", () => {
  it("pins the complete source and built-runtime provenance", () => {
    const candidate = loadCandidate();
    expect(candidate.schemaVersion).toBe(1);
    expect(candidate.status).toBe("build-passed-gpu-validation-pending");
    expect(candidate.source.patchCommits).toHaveLength(8);
    expect(candidate.source.changedFiles).toHaveLength(candidate.source.diffStat.files);
    expect(candidate.source.diffStat).toEqual({ files: 4, insertions: 98, deletions: 10 });
    for (const value of [
      candidate.source.upstreamBaseCommit,
      candidate.source.upstreamHeadCommit,
      ...candidate.source.patchCommits,
      candidate.productionRuntime.commit,
      candidate.candidateRuntime.backportCommit,
    ]) expect(value).toMatch(SHA40);
    for (const value of [
      candidate.productionRuntime.llamaBenchSha256,
      candidate.productionRuntime.vulkanLibrarySha256,
      candidate.candidateRuntime.sourceArchiveSha256,
      candidate.candidateRuntime.llamaBenchSha256,
      candidate.candidateRuntime.llamaServerSha256,
      candidate.candidateRuntime.backendOpsSha256,
      candidate.candidateRuntime.vulkanLibrarySha256,
      candidate.model.artifactSha256,
    ]) expect(value).toMatch(SHA256);
  });

  it("keeps KV-format and runtime effects in separate causal arms", () => {
    const candidate = loadCandidate();
    expect(candidate.localExperiment.contexts).toEqual([8192, 32768, 65536, 131072]);
    expect(candidate.localExperiment.arms).toEqual([
      { id: "production-f16-kv", runtime: "production", kvK: "f16", kvV: "f16", purpose: expect.any(String) },
      { id: "production-q8-kv", runtime: "production", kvK: "q8_0", kvV: "q8_0", purpose: expect.any(String) },
      { id: "candidate-q8-kv", runtime: "candidate", kvK: "q8_0", kvV: "q8_0", purpose: expect.any(String) },
    ]);
    expect(candidate.localExperiment.executionPolicy).toMatch(/exclusive maintenance window.*GPU lease/i);
    expect(candidate.localExperiment.residencyPolicy).toMatch(/restore.*success.*failure.*signal/i);
    expect(candidate.promotionGate).toEqual(expect.objectContaining({
      minimumCycles: 2,
      deploymentStatus: "not-authorized-by-evidence",
    }));
  });
});
