import {
  createControllerRecoverySocketClient,
  createWatchdogRecoverySocketClient,
  runUnixJson,
} from "../../scripts/constitutional-routing-cli.js";
import {
  ConstitutionalRoutingWatchdog,
  type AuthoritySnapshot,
  type ProtectedAuthorityReader,
} from "../../src/homeserver/constitutional-routing-controller.js";
import { readFileSync } from "node:fs";

const [mode, socket, handle, snapshotPath, clockMode] = process.argv.slice(2);
if (!mode || !socket) throw new Error("missing constitutional socket-client fixture argument");

const baseline = '{"route":"mellum"}\n';
const candidate = '{"route":"qwen"}\n';

if (mode === "controller-response-loss") {
  const lossyTransport: typeof runUnixJson = (socketPath, endpoint, input) => {
    const result = runUnixJson(socketPath, endpoint, input);
    if (endpoint === "/route/apply") {
      throw new Error("simulated response loss after server-side candidate CAS");
    }
    return result;
  };
  const controller = createControllerRecoverySocketClient(socket, lossyTransport);
  controller.recoveryRegistrar.registerPreRecovery({
    journalId: "micro-route-journal",
    bindingDigest: `sha256:${"1".repeat(64)}`,
    targetScopeDigest: `sha256:${"2".repeat(64)}`,
    baseline,
    baselineDigest: `sha256:f54252b363a0a7166f1ec8252a33a1c1533a695863e7fe8f1ae6dbb679bacca0`,
    candidateDigest: `sha256:0da510b6a5ff1eb2c28d558f4d9eb1ea879ef911d8a46a5fe94969bedbd07a88`,
    descriptorDigest: `sha256:${"3".repeat(64)}`,
  });
  const fence = controller.store.acquireWriterLease();
  let lost = "";
  try {
    controller.store.compareAndSwap(baseline, candidate, fence);
  } catch (error) {
    lost = error instanceof Error ? error.message : String(error);
  } finally {
    fence.release();
  }
  process.stdout.write(`${JSON.stringify({
    activeRegistration: controller.activeRegistration(),
    lost,
  })}\n`);
} else if (mode === "watchdog-recover") {
  if (!handle) throw new Error("missing recovery handle");
  const watchdog = createWatchdogRecoverySocketClient(socket);
  const fence = watchdog.acquireRouteFence();
  try {
    watchdog.blockRoute(fence);
    const classification = watchdog.actuatePreRegisteredRecovery({
      handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      fenceEpoch: fence.epoch,
      fenceToken: fence.token,
    });
    process.stdout.write(`${JSON.stringify({ classification })}\n`);
  } finally {
    watchdog.releaseRouteFence(fence);
  }
} else if (mode === "watchdog-route-digest") {
  const watchdog = createWatchdogRecoverySocketClient(socket);
  const fence = watchdog.acquireRouteFence();
  try {
    const digest = watchdog.readRouteDigest(fence);
    process.stdout.write(`${JSON.stringify({ digest })}\n`);
  } finally {
    watchdog.releaseRouteFence(fence);
  }
} else if (mode === "watchdog-tick") {
  if (!handle || !snapshotPath) throw new Error("missing watchdog data-dir or authority snapshot");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as AuthoritySnapshot;
  const now = "2026-07-26T00:00:00Z";
  const authority: ProtectedAuthorityReader = {
    read: () => structuredClone(snapshot),
    killSwitchActive: () => false,
    trustedNowIso: () => {
      if (clockMode === "unavailable") throw new Error("protected clock unavailable");
      return now;
    },
    liveness: () => ({ healthy: true, observedAt: now, digest: `sha256:${"9".repeat(64)}` }),
    currentDigests: () => ({
      config: `sha256:${"b".repeat(64)}`,
      evidence: `sha256:${"c".repeat(64)}`,
      policy: `sha256:${"d".repeat(64)}`,
      postconditions: `sha256:${"f".repeat(64)}`,
    }),
  };
  const verifier = {
    verify: (input: { candidateDigest: string; postconditionsDigest: string }) => ({
      ok: true,
      candidateDigest: input.candidateDigest,
      postconditionsDigest: input.postconditionsDigest,
      proofDigest: `sha256:${"7".repeat(64)}`,
    }),
  };
  const result = new ConstitutionalRoutingWatchdog(
    handle,
    authority,
    createWatchdogRecoverySocketClient(socket),
    undefined,
    undefined,
    undefined,
    verifier,
  ).tick();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  throw new Error(`unknown constitutional socket-client fixture mode: ${mode}`);
}
