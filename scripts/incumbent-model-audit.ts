#!/usr/bin/env tsx
/** Append-only, advisory incumbent evidence refresh (#11). */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditIncumbent } from "../src/homeserver/incumbent-audit.js";
import { getRunningCmd } from "../src/homeserver/model-admin.js";
import { PROBES, PROBE_BATTERY_VERSION, CORPUS_FINGERPRINT } from "../src/homeserver/probes.js";

function value(flag: string): string | undefined {
  const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1];
}
const model = value("--model");
if (!model) throw new Error("usage: incumbent-model-audit --model <served-model> [--trigger <reason>]");
const endpoint = (process.env["INCUMBENT_AUDIT_ENDPOINT"] ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
const output = resolve(process.env["INCUMBENT_AUDIT_REGISTRY"] ?? "./data/incumbent-audits.jsonl");
const record = await auditIncumbent({
  model, endpoint, trigger: value("--trigger") ?? "manual", probes: PROBES,
  probeBatteryVersion: PROBE_BATTERY_VERSION, corpusFingerprint: CORPUS_FINGERPRINT,
  getRunningCmd, repeats: Number(process.env["INCUMBENT_AUDIT_REPEATS"] ?? 1),
  apiKey: process.env["INCUMBENT_AUDIT_KEY"], timeoutMs: Number(process.env["INCUMBENT_AUDIT_TIMEOUT_MS"] ?? 180000),
});
mkdirSync(dirname(output), { recursive: true });
appendFileSync(output, JSON.stringify(record) + "\n", "utf8");
console.log(JSON.stringify({ model: record.model, status: record.status, output, auditedAt: record.auditedAt }));
