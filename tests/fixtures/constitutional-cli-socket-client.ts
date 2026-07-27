import {
  createControllerRecoverySocketClient,
  createWatchdogRecoverySocketClient,
  runUnixJson,
} from "../../scripts/constitutional-routing-cli.js";

const [mode, socket, handle] = process.argv.slice(2);
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
} else {
  throw new Error(`unknown constitutional socket-client fixture mode: ${mode}`);
}
