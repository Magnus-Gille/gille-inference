#!/usr/bin/env tsx
/**
 * Read-only offline evidence checker. Its result never authorizes a live
 * installation or changes any host state.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { evaluateInstallCoverage, type InstallCoverageReport } from "../src/homeserver/install-coverage.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const SOURCE = "install-coverage-check-v1" as const;

const usage =
  "Read-only offline evidence validation only; never live installation admission.\n" +
  "Usage: check-install-coverage INVENTORY.json BINDING.json EVIDENCE.json";

/** Read one stable, regular file without accepting a truncated or growing prefix. */
async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.size > BigInt(MAX_INPUT_BYTES)) throw new Error("input-unreadable");

    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const final = await handle.stat({ bigint: true });
    if (final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs) {
      throw new Error("input-changed");
    }
    if (BigInt(bytesRead) !== initial.size || bytesRead > MAX_INPUT_BYTES) throw new Error("input-unreadable");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function inputFailureReport(): InstallCoverageReport {
  return {
    source: SOURCE,
    coverage: "unknown",
    activity: "unknown",
    observedAt: null,
    inventorySha256: null,
    reasons: [{ code: "input-read-failed" }],
  };
}

function policyFailureReport(): InstallCoverageReport {
  return {
    source: SOURCE,
    coverage: "unknown",
    activity: "unknown",
    observedAt: null,
    inventorySha256: null,
    reasons: [{ code: "policy-rejection" }],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    process.exitCode = 0;
    return;
  }
  if (args.length !== 3) {
    console.error("invalid input: expected three JSON paths or --help");
    process.exitCode = 2;
    return;
  }

  let inventory: unknown;
  let binding: unknown;
  let evidence: unknown;
  try {
    [inventory, binding, evidence] = await Promise.all(args.map(readJson));
  } catch {
    console.error(JSON.stringify(inputFailureReport()));
    process.exitCode = 2;
    return;
  }

  let report: InstallCoverageReport;
  try {
    report = evaluateInstallCoverage(inventory, binding, evidence);
  } catch {
    report = policyFailureReport();
  }

  console.log(JSON.stringify(report));
  process.exitCode = report.coverage === "complete" && report.activity === "idle" ? 0 : 1;
}

void main().catch(() => {
  console.error(JSON.stringify(inputFailureReport()));
  process.exitCode = 2;
});
