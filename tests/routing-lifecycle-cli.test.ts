/**
 * Subprocess acceptance coverage for scripts/routing-lifecycle-cli.ts's `review` subcommand
 * (issue #7) — the IO composition root wiring the pure routing-lifecycle.ts logic to the ledger,
 * the filesystem, and the served-model catalogue. Mirrors generate-routing-table-guard.test.ts's
 * subprocess harness against a seeded temp ledger.
 *
 * The CLI's serving-catalogue probe (model-admin.ts's listModels()) has nothing real to reach in
 * this test environment, so `review` exercises the genuine fail-CLOSED path (AC: "never silently
 * keep a stale model id when the catalogue is unavailable") — that is the realistic, desired
 * behavior being pinned here, not a workaround.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation } from "../src/homeserver/ledger.js";
import { loadConfig } from "../src/homeserver/config.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "routing-lifecycle-cli.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-test-"));
  dbPath = join(dir, "eval.db");
  mkdirSync(join(dir, "data"));

  initDb(dbPath);
  for (let i = 0; i < 5; i++) {
    recordDelegation({
      taskType: "classify",
      modelId: "mellum",
      prompt: `classify probe ${i}`,
      outcome: "pass",
      verifier: "tsGate",
      source: "test-seed",
    });
  }
});

function runReview(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, "review", "--db", dbPath, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, EVAL_DB_PATH: dbPath, HOMESERVER_BACKEND: "llamaswap", LMSTUDIO_BASE_URL: "http://127.0.0.1:1/v1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("routing-lifecycle-cli.ts review (issue #7)", () => {
  it("produces a machine-readable artifact and exits non-zero when the catalogue is unreachable (fail closed)", () => {
    const r = runReview([]);
    expect(r.status).not.toBe(0); // never a silent pass with an unreachable catalogue
    const artifact = JSON.parse(r.stdout) as {
      schemaVersion: number;
      validation: { ok: boolean; issues: Array<{ code: string }> };
      candidateHash: string;
      humanDiff: string;
      lineage: unknown[];
    };
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "model-unavailable")).toBe(true);
    expect(typeof artifact.candidateHash).toBe("string");
    expect(Array.isArray(artifact.lineage)).toBe(true);
    expect(r.stderr).toMatch(/validation: REFUSED/);
  });

  it("writes the artifact to --out as well as stdout", () => {
    const out = join(dir, "artifact.json");
    const r = runReview(["--out", out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/wrote review artifact/);
  });

  it("rejects a malformed --calibration-gate file with a clear error, not a crash traceback dump", () => {
    const badGate = join(dir, "bad-gate.json");
    writeFileSync(badGate, JSON.stringify({ not: "a gate" }), "utf8");
    const r = runReview(["--calibration-gate", badGate]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a recognisable CalibrationGateDecision/);
  });
});

// ── issue #37: the live #6 calibration gate, and its fail-closed admissibility rule ──────────────

describe("routing-lifecycle-cli.ts review — live #6 calibration gate wiring (issue #37)", () => {
  // Reuses the SAME seeded db/dir as the outer describe block (module-scoped `dir`/`dbPath`) —
  // ledger.ts's ensureSchema() guards table creation behind a process-wide `_initialised` flag, so a
  // second `initDb(<new path>)` call within this same test file/process would silently skip
  // creating the delegations table on a fresh db file. Adding rows to the already-initialised db is
  // both correct and simpler.
  beforeAll(() => {
    // "instruction-multi-constraint" — an ad-hoc, evidence-backed task type OUTSIDE the base
    // taxonomy (routing-table-generator.ts's resolveRoutableTypes adds it as an "extra" from ledger
    // evidence alone) with ONLY harvest/organic-judge (llm-judge:*) evidence. Excluding organic
    // evidence leaves ZERO evidence for this task type at all, so its route is explained ONLY by
    // organic evidence — exactly the #6 admissibility class validateCandidate gates. ("classify"
    // already has 5 verifier-backed (tsGate) rows from the outer beforeAll — that evidence survives
    // organic exclusion unchanged, so it is NEVER organic-judge-dependent.)
    for (let i = 0; i < 5; i++) {
      recordDelegation({
        taskType: "instruction-multi-constraint",
        modelId: "mellum",
        prompt: `imc probe ${i}`,
        outcome: "pass",
        verifier: "llm-judge:gpt-oss-120b",
        source: "test-seed",
      });
    }
  });

  function runReviewGate(args: string[]): { status: number | null; stdout: string; stderr: string } {
    return runReview(args);
  }

  it("attaches a LIVE (non-null) calibration gate to the artifact when no --calibration-gate is given", () => {
    const r = runReviewGate([]);
    const artifact = JSON.parse(r.stdout) as {
      calibrationGate: { policyId: string; verdict: string; enabled: boolean } | null;
    };
    // Previously this was ALWAYS null — the CLI never evaluated the #6 gate at all.
    expect(artifact.calibrationGate).not.toBeNull();
    expect(typeof artifact.calibrationGate!.policyId).toBe("string");
    expect(r.stderr).toMatch(/calibration gate \(#6\):/);
  });

  it("refuses an organic-judge-dependent route change via the CLI path when the live gate is HOLD (fail closed, no receipts supplied)", () => {
    const r = runReviewGate([]);
    const artifact = JSON.parse(r.stdout) as {
      calibrationGate: { verdict: string; enabled: boolean } | null;
      validation: { ok: boolean; issues: Array<{ code: string; taskType?: string }> };
      lineage: Array<{ taskType: string; organicJudgeDependent: boolean }>;
    };
    // No Quality Receipts were supplied, so the live gate must be HOLD (or, if computed elsewhere as
    // null, that is equally fail-closed) — never a fabricated GO.
    expect(artifact.calibrationGate?.verdict === "HOLD" || artifact.calibrationGate === null).toBe(true);
    expect(artifact.lineage.find((l) => l.taskType === "instruction-multi-constraint")?.organicJudgeDependent).toBe(true);
    expect(
      artifact.validation.issues.some((i) => i.code === "inadmissible-organic-evidence" && i.taskType === "instruction-multi-constraint")
    ).toBe(true);
  });

  it("does NOT gate a verifier-backed change — classify proceeds past the #6 rule regardless of the HOLD gate", () => {
    const r = runReviewGate([]);
    const artifact = JSON.parse(r.stdout) as {
      validation: { issues: Array<{ code: string; taskType?: string }> };
      lineage: Array<{ taskType: string; organicJudgeDependent: boolean }>;
    };
    expect(artifact.lineage.find((l) => l.taskType === "classify")?.organicJudgeDependent).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "inadmissible-organic-evidence" && i.taskType === "classify")).toBe(false);
  });

  it("an organic-judge-dependent change proceeds past the #6 rule when an explicit GO+enabled gate is supplied", () => {
    const goGate = join(dir, "go-enabled-gate.json");
    writeFileSync(
      goGate,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "test-policy",
        generatedAt: "2026-07-20T00:00:00.000Z",
        verdict: "GO",
        reasons: ["all trusted groups cleared thresholds (test fixture)"],
        thresholds: { minStratumN: 30, minPrecisionLowerBound: 0.9, minRecallLowerBound: 0.8, maxDisagreementUpperBound: 0.1, confidenceZ: 1.96 },
        metrics: {},
        enabling: { reviewerId: "test-reviewer", reason: "test fixture", decisionRef: "grimnir#88", reviewedAt: "2026-07-20T00:00:00.000Z" },
      }),
      "utf8"
    );
    const r = runReviewGate(["--calibration-gate", goGate]);
    const artifact = JSON.parse(r.stdout) as {
      calibrationGate: { verdict: string; enabled: boolean } | null;
      validation: { issues: Array<{ code: string; taskType?: string }> };
    };
    expect(artifact.calibrationGate).toEqual({
      policyId: "test-policy",
      generatedAt: "2026-07-20T00:00:00.000Z",
      verdict: "GO",
      enabled: true,
    });
    expect(artifact.validation.issues.some((i) => i.code === "inadmissible-organic-evidence")).toBe(false);
  });
});

// ── issue #37: adopt-time re-validation against the LIVE gate ────────────────────────────────────

describe("routing-lifecycle-cli.ts adopt — re-validates the #6 gate LIVE at adopt time (issue #37)", () => {
  function runAdopt(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [TSX, SCRIPT, "adopt", "--db", dbPath, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, EVAL_DB_PATH: dbPath, HOMESERVER_BACKEND: "llamaswap", LMSTUDIO_BASE_URL: "http://127.0.0.1:1/v1" },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("refuses BEFORE any write when a lineage entry is organic-judge-dependent and no receipts make the live gate anything but HOLD", () => {
    // A deliberately minimal artifact — only `lineage` is read before this refusal fires, proving
    // the check runs ahead of approveArtifact/adoptRoutingTable (no artifactHash/policyEpochHash
    // bookkeeping needed to exercise it).
    const artifactPath = join(dir, "organic-dependent-artifact.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        lineage: [{ taskType: "instruction-multi-constraint", model: "mellum", verdict: "delegate-local", attempts: 5, organicJudgeDependent: true }],
      }),
      "utf8"
    );
    const r = runAdopt([
      "--artifact", artifactPath,
      "--approved-by", "test-operator",
      "--reason", "test adoption",
      "--decision-ref", "grimnir#88",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/adopt refused: organic-judge-dependent route change\(s\) \[instruction-multi-constraint\]/);
    expect(r.stderr).toMatch(/LIVE #6 gate to be GO\+enabled at adopt time/);
  });

  it("a verifier-backed (non-organic-dependent) change is NOT refused by the #6 rule — it proceeds to the reload step regardless of the live gate", () => {
    const config = loadConfig();
    const policyEpochHash = contentDigest(JSON.stringify(config.policy));
    const artifactPath = join(dir, "verifier-backed-artifact.json");
    const tablePath = join(dir, "adopt-target-table.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        schemaVersion: 1,
        candidateHash: "test-candidate-hash",
        adoptedHash: null,
        policyEpochHash,
        diff: { changes: [], downgrades: [] },
        validation: { ok: true, issues: [] },
        calibrationGate: null,
        lineage: [{ taskType: "classify", model: "mellum", verdict: "delegate-local", attempts: 5, organicJudgeDependent: false }],
        candidate: { routing: {}, escalateToFrontier: [] },
      }),
      "utf8"
    );
    // No ROUTING_LIFECYCLE_ADMIN_KEY / HOMESERVER_OWNER_KEY set, and an unreachable --gateway-url —
    // this is expected to fail at the RELOAD step (not the organic-gate check), which both proves
    // the #6 rule did not block a non-organic-dependent change AND exercises the #38 actionable
    // missing-admin-key error end to end, fully offline (no network call is even attempted).
    const r = runAdopt([
      "--artifact", artifactPath,
      "--approved-by", "test-operator",
      "--reason", "test adoption",
      "--decision-ref", "grimnir#88",
      "--table", tablePath,
      "--gateway-url", "http://127.0.0.1:1",
    ]);
    expect(r.stderr).not.toMatch(/adopt refused: organic-judge-dependent/);
    expect(r.stdout).toMatch(/no admin key available/);
    expect(r.stdout).toMatch(/ROUTING_LIFECYCLE_ADMIN_KEY.*HOMESERVER_OWNER_KEY|HOMESERVER_OWNER_KEY.*ROUTING_LIFECYCLE_ADMIN_KEY/);
    expect(r.status).toBe(1); // RELOAD FAILED (missing key), rolled back — a real, later-stage failure
    expect(r.stderr).toMatch(/RELOAD FAILED, rolled back/);
  });
});
