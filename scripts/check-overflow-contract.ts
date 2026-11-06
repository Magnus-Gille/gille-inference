#!/usr/bin/env tsx
/**
 * Context-overflow contract probe CLI (INFER-510).
 *
 * Default is an OFFLINE plan: no network, no credentials. A live run needs --live and an
 * --envelope-ref naming the separately approved envelope. The reference is only RECORDED in the
 * output, not verified, and this probe neither checks nor takes the GPU lease: the operator must
 * arrange the lease, admission and owner preemption. It sends 2 inference calls per target. It is
 * never invoked by scripts/deploy-gateway.sh. Limits come from certified evidence (INFER-125).
 * --base-url must be https (loopback may be http), with no credentials, query, fragment or path
 * prefix.
 *
 * Usage:
 *   check-overflow-contract --targets TARGETS.json
 *   check-overflow-contract --targets TARGETS.json --live --envelope-ref REF --base-url URL [--key-env NAME]
 */
import { readFile } from "node:fs/promises";
import { parseBaseUrl, parseOverflowTargets, planOverflowProbe, runOverflowProbe } from "../src/homeserver/overflow-contract-probe.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(args: string[]): Promise<number> {
  const file = flag(args, "--targets");
  if (!file) {
    console.error("Usage: check-overflow-contract --targets TARGETS.json [--live --envelope-ref REF --base-url URL [--key-env NAME]]");
    return 2;
  }
  const targets = parseOverflowTargets(JSON.parse(await readFile(file, "utf8")));
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ mode: "plan", network: false, plan: planOverflowProbe(targets) }, null, 2));
    return 0;
  }
  const envelopeRef = flag(args, "--envelope-ref");
  const baseUrl = flag(args, "--base-url");
  if (!envelopeRef || !/^[A-Za-z0-9._:-]{3,64}$/.test(envelopeRef) || !baseUrl) {
    console.error("--live requires --envelope-ref (recorded, not verified: name the approved envelope) and --base-url.");
    return 2;
  }
  const keyEnv = flag(args, "--key-env") ?? "OVERFLOW_PROBE_API_KEY";
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    console.error(`Environment variable ${keyEnv} is not set.`);
    return 2;
  }
  const report = await runOverflowProbe(targets, { baseUrl: parseBaseUrl(baseUrl), apiKey });
  console.log(JSON.stringify({ mode: "live", envelopeRef, ...report }, null, 2));
  return report.allFixedVerified ? 0 : 1;
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  (error: unknown) => { console.error(error instanceof Error ? error.message : "overflow-probe-failed"); process.exitCode = 2; },
);
