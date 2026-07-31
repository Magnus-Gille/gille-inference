#!/usr/bin/env node
import { readFileSync } from "node:fs";

const matrixPath = new URL("../docs/m5-delegated-context-matrix.json", import.meta.url);
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

const requiredContexts = new Map([
  ["codex-root", "supported"],
  ["codex-repo-subagent", "supported"],
  ["claude-real-session", "supported"],
  ["pi-delegated-leaf", "unsupported"],
]);
const secretPattern = /(?:\bbearer\s+(?:hs_[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]{32,})|\bhs_[A-Za-z0-9._~-]+|authorization\s*[:=]|\btoken\s*[:=]\s*\S+)/i;

function fail(message) {
  throw new Error(`M5 delegated-context matrix invalid: ${message}`);
}

if (!matrix || matrix.schema_version !== 1 || !Array.isArray(matrix.contexts)) {
  fail("expected schema_version 1 and a contexts array");
}
if (matrix.contexts.length !== requiredContexts.size) {
  fail(`expected exactly ${requiredContexts.size} declared contexts`);
}

const seen = new Set();
for (const context of matrix.contexts) {
  if (!context || typeof context !== "object") fail("each context must be an object");
  const expectedStatus = requiredContexts.get(context.id);
  if (!expectedStatus) fail(`unexpected context id ${JSON.stringify(context.id)}`);
  if (seen.has(context.id)) fail(`duplicate context id ${context.id}`);
  seen.add(context.id);
  if (context.status !== expectedStatus) fail(`${context.id} must be ${expectedStatus}`);
  if (secretPattern.test(JSON.stringify(context))) fail(`${context.id} contains secret-shaped material`);

  if (context.status === "supported") {
    if (!context.evidence || typeof context.evidence.source !== "string" || context.evidence.source.length === 0) {
      fail(`${context.id} needs a source-backed evidence declaration`);
    }
    if (context.evidence.kind === "ledger-receipts") {
      if (!Array.isArray(context.evidence.ledger_ids) || context.evidence.ledger_ids.length === 0) {
        fail(`${context.id} needs at least one ledger receipt`);
      }
      for (const ledgerId of context.evidence.ledger_ids) {
        if (typeof ledgerId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(ledgerId)) {
          fail(`${context.id} has an invalid ledger receipt id`);
        }
      }
    }
  } else if (typeof context.reason !== "string" || typeof context.next_probe !== "string") {
    fail(`${context.id} needs an explicit reason and next_probe`);
  }
}

for (const id of requiredContexts.keys()) {
  if (!seen.has(id)) fail(`missing required context ${id}`);
}

process.stdout.write(`M5 delegated-context matrix check passed: ${matrix.contexts.length} contexts.\n`);
