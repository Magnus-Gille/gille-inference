import { readFileSync, writeFileSync } from "node:fs";
import { ConstitutionalRoutingController, type AuthoritySnapshot, type RouteMutationPlan } from "../../src/homeserver/constitutional-routing-controller.js";

const [mode, dataDir, tablePath, snapshotPath, planPath] = process.argv.slice(2);
if (!mode || !dataDir || !tablePath || !snapshotPath || !planPath) throw new Error("missing child harness argument");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as AuthoritySnapshot;
const plan = JSON.parse(readFileSync(planPath, "utf8")) as RouteMutationPlan;
const authority = {
  read: () => structuredClone(snapshot),
  killSwitchActive: () => false,
  trustedNowIso: () => "2026-07-26T00:00:00Z",
  liveness: () => ({ healthy: true, observedAt: "2026-07-26T00:00:00Z", digest: `sha256:${"9".repeat(64)}` }),
  currentDigests: () => ({
    config: plan.configDigest,
    evidence: plan.evidenceDigest,
    policy: plan.policyDigest,
    postconditions: plan.postconditionsDigest,
  }),
};
const controller = new ConstitutionalRoutingController(
  dataDir,
  {
    read: () => readFileSync(tablePath, "utf8"),
    compareAndSwap: (expected, next) => {
      if (readFileSync(tablePath, "utf8") !== expected) return false;
      writeFileSync(tablePath, next, "utf8");
      if (mode === "kill9") process.kill(process.pid, "SIGKILL");
      return true;
    },
  },
  authority,
  { verify: (input) => ({ ok: true, candidateDigest: input.candidateDigest, postconditionsDigest: input.postconditionsDigest, proofDigest: `sha256:${"7".repeat(64)}` }) },
);
controller.begin(plan);
process.stdout.write("WATCHING\n");
setInterval(() => undefined, 60_000);
