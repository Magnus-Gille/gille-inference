/** Native CI only: actual gateway/runtime, synthetic backend and Pi, no injected transport. */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initDb } from "../../src/db.js";
import { mintKey } from "../../src/homeserver/keystore.js";
import { resetConfig } from "../../src/homeserver/config.js";
import { startGateway } from "../../src/homeserver/gateway.js";

const root = process.env["RECOVERY_FIXTURE_ROOT"];
if (root !== "/run/gi-code-loop-recovery-fixture") throw new Error("fixture root mismatch");
let inferenceRequests = 0;
const backend = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && path === "/v1/models") {
    res.end(JSON.stringify({ object: "list", data: [{ id: "synthetic-recovery", object: "model" }] }));
  } else if (req.method === "GET" && path === "/running") {
    res.end(JSON.stringify({ running: [{ model: "synthetic-recovery", state: "ready" }] }));
  } else {
    inferenceRequests++;
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "synthetic fixture refuses inference" }));
  }
});
await new Promise<void>((resolve, reject) => {
  backend.once("error", reject);
  backend.listen(0, "127.0.0.1", resolve);
});
const address = backend.address();
if (!address || typeof address === "string") throw new Error("backend not listening");
process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:" + address.port + "/v1";
process.env["HOMESERVER_HOST"] = "127.0.0.1";
process.env["HOMESERVER_PORT"] = "18457";
process.env["HOMESERVER_CODE_LOOP"] = "on";
process.env["HOMESERVER_CODE_LOOP_CONFINEMENT"] = "required";
process.env["HOMESERVER_CODE_LOOP_RUNTIME_PI_BIN"] = join(root, "bin", "synthetic-pi");
process.env["HOMESERVER_CODE_LOOP_RUNTIME_PI_AGENT_DIR"] = join(root, "home", "pi");
process.env["HOMESERVER_CODE_LOOP_RUNTIME_NODE_MODULES_DIR"] = join(root, "source", "node_modules");
process.env["HOMESERVER_CODE_LOOP_RUNTIME_WORKROOT"] = join(root, "home", "work");
process.env["HOMESERVER_CODE_LOOP_MODEL"] = "synthetic-recovery";
process.env["HOMESERVER_CODE_LOOP_FORWARD_PORT"] = "18456";
process.env["HOMESERVER_GPU_LEASE_DIR"] = join(root, "home", "leases");
process.env["HOMESERVER_HOST_MEMORY_ADMISSION"] = "off";
process.env["HOMESERVER_ACCESS_LOG"] = "off";
process.env["GILLE_AUTONOMY_ENV_FILE"] = join(root, "home", "synthetic-secret-marker.txt");
initDb(join(root, "home", "fixture.sqlite"));
const key = mintKey({ alias: "synthetic-recovery", tier: "owner", scope: "agent" },
  { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 }).plaintextKey;
process.env["HOMESERVER_CODE_LOOP_API_KEY"] = key;
resetConfig();
const gateway = await startGateway();
writeFileSync(join(root, "home", "client.json"), JSON.stringify({
  port: gateway.port, key, pid: process.pid, traffic: "synthetic",
}), { mode: 0o600 });
console.log("Actual fixture gateway ready; backend/model/Pi responses are synthetic.");
const close = async (): Promise<void> => {
  writeFileSync(join(root, "home", "backend-count.json"), JSON.stringify({ inferenceRequests }), { mode: 0o600 });
  await gateway.stop();
  backend.close();
};
process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
