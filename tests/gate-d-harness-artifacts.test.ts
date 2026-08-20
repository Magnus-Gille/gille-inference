import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const RUN = join(ROOT, "gate-d", "run.sh");
const CHECK = join(ROOT, "gate-d", "check.sh");

/**
 * Every artifact run.sh writes into the graded work dir must be exempted from check.sh's G0a
 * "changed outside the task's declared edit targets" gate.
 *
 * Regression: `4787ed7` added `$W/.arm.stderr.log` and `$W/.arm-telemetry.json` to run.sh without
 * extending check.sh's exemption list (last touched at the initial public release). Because G0a
 * walks the union of seed+work files, the harness's own stderr/telemetry captures were graded as
 * illegal agent edits — so EVERY pi-arm run failed G0-files regardless of what the model did.
 *
 * This test derives the artifact list from run.sh rather than hard-coding it, so adding a new
 * `$W/.<artifact>` write without exempting it fails here instead of silently zeroing a sweep.
 */
function harnessArtifacts(): string[] {
  const run = readFileSync(RUN, "utf8");
  const found = new Set<string>();
  for (const m of run.matchAll(/\$W\/(\.[A-Za-z0-9._-]+)/g)) found.add(m[1]!);
  return [...found].sort();
}

function exemptedInCheck(): string[] {
  const check = readFileSync(CHECK, "utf8");
  const m = check.match(/case\s+"\$f"\s+in\s+([^)]+)\)/);
  if (!m) throw new Error("check.sh: could not locate the G0a `case \"$f\" in ...)` exemption list");
  return m[1]!
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

describe("Gate D harness-owned work-dir artifacts", () => {
  it("run.sh actually writes artifacts into the work dir (guards the regex itself)", () => {
    const artifacts = harnessArtifacts();
    expect(artifacts.length).toBeGreaterThan(0);
    // Anchor on the two that predate the regression so a broken regex can't vacuously pass.
    expect(artifacts).toContain(".arm.log");
    expect(artifacts).toContain(".check.log");
  });

  it("exempts every work-dir artifact run.sh writes from the G0a edit-scope gate", () => {
    const artifacts = harnessArtifacts();
    const exempt = exemptedInCheck();
    const missing = artifacts.filter((a) => !exempt.includes(a));
    expect(
      missing,
      `check.sh's G0a exemption is missing harness-owned artifact(s): ${missing.join(", ")}. ` +
        `run.sh writes ${artifacts.join(", ")} into the graded work dir; each must be exempted ` +
        `or every run fails G0-files on the harness's own output.`
    ).toEqual([]);
  });
});
