import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sample = JSON.parse(readFileSync(new URL("artifacts/sample.json", import.meta.url), "utf8"));
assert.equal(sample.schemaVersion, 1);
assert.match(sample.scope.baselineSha, /^[0-9a-f]{40}$/);
assert.equal(sample.complexityTop10.length, 10);
assert.equal(sample.scope.coverage.unimportedEligible.lines.pct, 0);
assert.equal(sample.scope.nativeAndScriptChecks.pythonFilesParsed, 10);
assert.ok(sample.tools.knip && sample.tools.c8 && sample.tools.eslint);
assert.equal(sample.validRerun.knipNormal.candidateFiles, 101);
assert.equal(sample.validRerun.typescriptCoverage.tests.passed, 34);
assert.equal(sample.validRerun.typescriptCoverage.selectedFiles["src/homeserver/image-sidecar.ts"].lines.pct, 0);
assert.match(sample.validRerun.typescriptCoverage.decision, /adopt bounded report-only/);
console.log(`verified code-health sample: ${sample.scope.baselineSha}; top10=${sample.complexityTop10.length}; unimportedCoverage=${sample.scope.coverage.unimportedEligible.lines.pct}%`);
