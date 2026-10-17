import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const root = "/run/gi-code-loop-recovery-fixture";
const uid = Number(process.argv[2]);
assert(Number.isSafeInteger(uid) && uid === 62056, "declared test UID only");
const unit = "user@" + uid + ".service";
const run = (...args) => execFileSync("systemctl", args, { encoding: "utf8" }).trim();
const prop = (name, field) => run("show", name, "--property=" + field, "--value");
const wait = async (test, label, ms = 30000) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + label);
};
await wait(() => existsSync(root + "/home/client.json"), "actual gateway startup");
const client = JSON.parse(readFileSync(root + "/home/client.json", "utf8"));
const url = "http://127.0.0.1:" + client.port;
const pidIdentity = (pid) => {
  const text = readFileSync("/proc/" + pid + "/stat", "utf8");
  return { pid, startTicks: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};
const gatewayIdentity = pidIdentity(Number(prop("gi-recovery-gateway.service", "MainPID")));
assert.equal(gatewayIdentity.pid, client.pid);
assert.deepEqual(prop("gi-recovery-gateway.service", "RestrictAddressFamilies").split(/\s+/).sort(),
  ["AF_UNIX", "AF_INET", "AF_INET6"].sort(), "gateway address-family boundary differs from production");
assert.equal(prop("gi-recovery-gateway.service", "NoNewPrivileges"), "yes");
assert.equal(prop("gi-recovery-gateway.service", "PrivateDevices"), "yes");
assert.equal(prop("gi-recovery-gateway.service", "CapabilityBoundingSet"), "");
const canaryIdentity = pidIdentity(Number(prop("gi-recovery-canary.service", "MainPID")));
const dirIdentity = statSync("/run/user/" + uid).ino;
const initialManager = Number(prop(unit, "MainPID"));
assert(initialManager > 1);
assert.equal(prop(unit, "Restart"), "on-failure");
assert.equal(prop(unit, "OOMScoreAdjust"), "-500");
assert.equal(prop("girecovery.slice", "MemoryMax"), "2147483648");
assert.equal(prop("girecovery.slice", "MemorySwapMax"), "0");
assert.equal(prop("girecovery.slice", "TasksMax"), "128");
assert.equal(prop("girecovery.slice", "CPUQuotaPerSecUSec"), "2s");
for (const name of [unit, "user-runtime-dir@" + uid + ".service", "gi-recovery-gateway.service", "gi-recovery-canary.service"]) {
  const state = {
    slice: prop(name, "Slice"), controlGroup: prop(name, "ControlGroup"),
    mainPid: Number(prop(name, "MainPID")), controlPid: Number(prop(name, "ControlPID")),
    type: prop(name, "Type"), subState: prop(name, "SubState"),
  };
  assert.equal(state.slice, "girecovery.slice", name + " has a different configured slice");
  // The stock runtime-directory helper is oneshot/RemainAfterExit: after its
  // process exits, systemd can discard its empty cgroup while keeping it active.
  if (name === "user-runtime-dir@" + uid + ".service" && state.controlGroup === "") {
    assert.equal(state.type, "oneshot");
    assert.equal(state.subState, "exited");
    assert.equal(state.mainPid, 0);
    assert.equal(state.controlPid, 0);
  } else {
    assert(state.controlGroup.startsWith("/girecovery.slice/"), name + " escaped fixture slice: " + JSON.stringify(state));
  }
}
const health = async () => {
  const res = await fetch(url + "/healthz", { signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 200);
  return (await res.json()).codeLoopTransport;
};
let id = 0;
const call = async (name, args) => {
  const res = await fetch(url + "/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + client.key },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(res.status, 200);
  const rpc = await res.json();
  assert(!rpc.error, "MCP protocol error");
  const result = rpc.result;
  assert(result && result.content?.[0]?.type === "text");
  return { ...result, payload: JSON.parse(result.content[0].text) };
};
const args = (phase) => ({
  client_run_id: "native-recovery-" + phase, traffic_purpose: "synthetic",
  instruction: "Synthetic fixture: replace result.txt with 'synthetic cage recovery passed'.",
  files: [{ path: "result.txt", content: "seed\n" }], writable: ["result.txt"],
  check_cmd: "grep -qx 'synthetic cage recovery passed' result.txt",
});
const smoke = async (phase) => {
  const started = await call("code_loop_start", args(phase));
  assert(!started.isError && started.payload.work_id, "synthetic real-cage start failed: " + JSON.stringify(started.payload));
  const workId = started.payload.work_id;
  let terminal;
  await wait(async () => {
    const status = await call("code_loop_status", { work_id: workId });
    if (status.payload.status === "running") return false;
    terminal = await call("code_loop_result", { work_id: workId });
    return true;
  }, "real cage " + phase, 60000);
  const result = terminal.payload;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.check.ran, true);
  assert.equal(result.check.exit_code, 0);
  assert.deepEqual(result.changed_files, ["result.txt"]);
  assert.match(result.diff, /\+synthetic cage recovery passed/);
  assert.deepEqual(result.scope_violations, []);
  assert.deepEqual(result.protected_violations, []);
  return { status: result.status, check: "passed", synthetic: true };
};
assert.equal(await health(), "available");
const baseline = await smoke("baseline");
const restartBefore = Number(prop(unit, "NRestarts"));
unlinkSync(root + "/gate/release");
if (existsSync(root + "/gate/entered")) unlinkSync(root + "/gate/entered");
// Kill exactly the fixture manager main process. No restart/start command is permitted in the exercise.
run("kill", "--kill-whom=main", "--signal=KILL", unit);
await wait(() => existsSync(root + "/gate/entered") && Number(prop(unit, "NRestarts")) > restartBefore, "automatic restart entered bounded gate");
assert.equal(prop(unit, "MainPID"), "0");
assert.equal(await health(), "unavailable");
const outage = await call("code_loop_start", args("outage-fresh-id"));
assert.equal(outage.isError, true);
assert.equal(outage.payload.refusal, "cage-transport-unavailable");
assert.equal(outage.payload.work_id, undefined);
assert.deepEqual(pidIdentity(Number(prop("gi-recovery-gateway.service", "MainPID"))), gatewayIdentity);
writeFileSync(root + "/gate/release", "release\n");
await wait(async () => Number(prop(unit, "MainPID")) > 1 && Number(prop(unit, "MainPID")) !== initialManager && await health() === "available", "automatic recovery");
assert.equal(statSync("/run/user/" + uid).ino, dirIdentity, "runtime directory replaced");
const recovered = await smoke("recovered");
assert.deepEqual(pidIdentity(Number(prop("gi-recovery-gateway.service", "MainPID"))), gatewayIdentity);
assert.deepEqual(pidIdentity(Number(prop("gi-recovery-canary.service", "MainPID"))), canaryIdentity);
// Exercise the optional whole-job deadline in the real gateway and real user-manager cage.
// The synthetic Pi exits normally; this deliberately stalled owner check must be killed without
// publishing its already-harvested patch, and the next job must acquire the released resources.
const boundedArgs = args("whole-job-deadline");
boundedArgs.caps = { wall_s: 30, total_wall_s: 90 };
boundedArgs.check_cmd = "trap '' TERM; sleep 120";
const deadlineStartedAt = performance.now();
const boundedStart = await call("code_loop_start", boundedArgs);
assert(!boundedStart.isError && boundedStart.payload.work_id, "bounded real-cage admission failed");
const boundedWorkId = boundedStart.payload.work_id;
assert.match(boundedWorkId, /^cl-[a-zA-Z0-9-]+$/);
let boundedResult;
await wait(async () => {
  const status = await call("code_loop_status", { work_id: boundedWorkId });
  if (status.payload.status === "running") return false;
  boundedResult = (await call("code_loop_result", { work_id: boundedWorkId })).payload;
  return true;
}, "whole-job deadline and cleanup", 90000);
const boundedElapsedMs = Math.ceil(performance.now() - deadlineStartedAt);
assert(boundedElapsedMs <= 90000, "whole-job dispatch-to-cleanup exceeded its 90s budget");
assert.equal(boundedResult.status, "cap-exceeded");
assert.equal(boundedResult.check.ran, true, "deadline must interrupt the real caged owner check");
assert.equal(boundedResult.check.exit_code, null);
assert.equal(boundedResult.diff, "");
assert.equal(boundedResult.summary, "");
assert.equal(boundedResult.execution.whole_job.budget_s, 90);
assert(boundedResult.execution.whole_job.elapsed_ms <= 90000);
assert.equal(boundedResult.execution.whole_job.cleanup_complete, true);
const absent = spawnSync("runuser", ["-u", "gi-code-loop-ci", "--", "env", "-i",
  "PATH=/usr/bin:/bin", "XDG_RUNTIME_DIR=/run/user/" + uid,
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + uid + "/systemd/private",
  "systemctl", "--user", "show", "code-loop-" + boundedWorkId, "--property=LoadState", "--value"],
  { encoding: "utf8", timeout: 10000 });
assert.equal(absent.status, 0, "manager must answer the exact unit absence query");
assert.equal(absent.stdout.trim(), "not-found", "deadline left a cgroup unit behind");
const afterDeadline = await smoke("after-deadline");
assert.deepEqual(pidIdentity(Number(prop("gi-recovery-gateway.service", "MainPID"))), gatewayIdentity);
assert.deepEqual(pidIdentity(Number(prop("gi-recovery-canary.service", "MainPID"))), canaryIdentity);
writeFileSync(root + "/acceptance.json", JSON.stringify({
  baseline, outage: "cage-transport-unavailable", recovered,
  deadline: { status: boundedResult.status, elapsedMs: boundedElapsedMs, cleanupComplete: true, outputWithheld: true },
  afterDeadline,
  managerRestartedAutomatically: true, gatewayIdentityUnchanged: true,
  runtimeDirectoryUnchanged: true, fixtureCanaryUnchanged: true,
  resourceCeiling: { memoryBytes: 2147483648, swapBytes: 0, cpus: 2, tasks: 128 },
  caveat: "Real gateway/systemd/pasta/bwrap execution; synthetic engine/model; no inference-quality claim",
}, null, 2) + "\n");
console.log("Native recovery accepted: real MCP refusal, automatic manager recovery, unchanged gateway, real caged jobs.");
