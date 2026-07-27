import { readFileSync } from "node:fs";
import { ConstitutionalRoutingController, type AuthoritySnapshot, type RouteMutationPlan } from "../../src/homeserver/constitutional-routing-controller.js";
import { ConstitutionalRouteDatabase } from "../../src/homeserver/constitutional-route-database.js";

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
const route = new ConstitutionalRouteDatabase(tablePath);
const controller = new ConstitutionalRoutingController(
  dataDir,
  {
    read: () => route.read(),
    acquireWriterLease: (options) => route.acquireWriterLease(options),
    compareAndSwap: (expected, next, fence) => {
      if (mode === "stop") {
        process.stdout.write("AFTER-CLIENT-CHECK-BEFORE-RESOURCE-MUTATION\n");
        process.kill(process.pid, "SIGSTOP");
      }
      const changed = route.compareAndSwap(expected, next, fence);
      if (mode === "kill9") process.kill(process.pid, "SIGKILL");
      return changed;
    },
  },
  authority,
  { verify: (input) => ({ ok: true, candidateDigest: input.candidateDigest, postconditionsDigest: input.postconditionsDigest, proofDigest: `sha256:${"7".repeat(64)}` }) },
  {
    registerPreRecovery: () => ({
      handle: "recovery-00000000-0000-4000-8000-000000000000",
      registrationDigest: `sha256:${"6".repeat(64)}`,
    }),
  },
  undefined,
  { durationMs: 150 },
);
controller.begin(plan);
process.stdout.write("WATCHING\n");
setInterval(() => undefined, 60_000);
