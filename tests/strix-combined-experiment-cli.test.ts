import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preflightArtifacts, runBackendCorrectness } from "../scripts/strix-combined-experiment.js";
import { validateStrixKvCandidateConfig } from "../src/homeserver/strix-combined-experiment.js";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Strix combined experiment preflight", () => {
  it("hashes every used artifact and rejects cross-config or version drift before mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "strix-combined-preflight-"));
    const executable = join(directory, "fake-bin");
    const data = join(directory, "artifact");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    writeFileSync(data, "pinned-artifact\n");
    const executableSha = sha256(executable);
    const dataSha = sha256(data);
    const raw = JSON.parse(readFileSync("configs/strix-kv-dequant-qwen36.json", "utf8")) as Record<string, any>;
    Object.assign(raw.productionRuntime, {
      llamaBenchPath: executable,
      llamaBenchSha256: executableSha,
      vulkanLibraryPath: data,
      vulkanLibrarySha256: dataSha,
    });
    Object.assign(raw.candidateRuntime, {
      sourceArchivePath: data,
      sourceArchiveSha256: dataSha,
      llamaBenchPath: executable,
      llamaBenchSha256: executableSha,
      llamaServerPath: executable,
      llamaServerSha256: executableSha,
      backendOpsPath: executable,
      backendOpsSha256: executableSha,
      vulkanLibraryPath: data,
      vulkanLibrarySha256: dataSha,
    });
    Object.assign(raw.model, { path: data, artifactSha256: dataSha });
    const config = validateStrixKvCandidateConfig(raw);
    const mmapPath = join(directory, "mmap.json");
    const writeMmap = (quant = config.model.quant): void => writeFileSync(mmapPath, JSON.stringify({
      schemaVersion: 1,
      binaryPath: executable,
      modelPath: data,
      modelId: "qwen36-a3b",
      runtimeCommit: config.productionRuntime.commit,
      runtimeBinarySha256: executableSha,
      modelArtifactSha256: dataSha,
      backend: "vulkan",
      quant,
      biosUma: "test",
      powerMode: "test",
      port: 5818,
      commonArgs: ["-ngl", "99"],
    }));
    writeMmap();
    const versions = (path: string): string => path === executable
      ? `${config.productionRuntime.commit} ${config.candidateRuntime.backportCommit}`
      : "unexpected";
    await expect(preflightArtifacts(config, mmapPath, versions)).resolves.toMatchObject({
      hashes: { model: dataSha, candidateBackendOps: executableSha },
    });
    const failingExecutable = join(directory, "failing-backend");
    writeFileSync(failingExecutable, "#!/bin/sh\nprintf 'backend diagnostics'\nprintf 'backend warning' >&2\nexit 7\n");
    chmodSync(failingExecutable, 0o700);
    const failingConfig = structuredClone(config);
    failingConfig.candidateRuntime.backendOpsPath = failingExecutable;
    failingConfig.candidateRuntime.backendOpsSha256 = sha256(failingExecutable);
    await expect(runBackendCorrectness(failingConfig)).resolves.toMatchObject({
      exitCode: 7,
      stdoutBytes: 19,
      stderrBytes: 15,
      outputWithinLimit: true,
    });
    writeMmap("wrong-quant");
    await expect(preflightArtifacts(config, mmapPath, versions)).rejects.toThrow(/do not bind/);
    writeMmap();
    await expect(preflightArtifacts(config, mmapPath, () => "wrong-version")).rejects.toThrow(/version does not prove/);
    writeFileSync(data, "drifted\n");
    await expect(preflightArtifacts(config, mmapPath, versions)).rejects.toThrow(/hash differs/);
  });
});
