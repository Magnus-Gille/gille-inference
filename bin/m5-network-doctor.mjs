#!/usr/bin/env node
// Local prerequisites only: never infer gateway, credential, or connector health.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BASE_KEYS = ["M5_GATEWAY_URL", "M5_OPENAI_BASE_URL", "M5_BASE_URL"];
const STATES = new Map([
  ["Running", "running"], ["Stopped", "stopped"], ["NeedsLogin", "needs_login"],
  ["NeedsMachineAuth", "needs_machine_auth"], ["Starting", "starting"],
  ["NoState", "unknown"],
]);
const ACTIONS = {
  unconfigured: "Configure an explicit public base or select the private route explicitly.",
  invalid_configuration: "Correct the public base configuration; do not rotate credentials.",
  stopped: "Ask the owner to start Tailscale with its existing configuration, then rerun this diagnostic.",
  needs_login: "Ask the owner to restore Tailscale login, then rerun this diagnostic.",
  needs_machine_auth: "Ask the owner to check Tailscale device authorization.",
  starting: "Wait for Tailscale startup, then rerun this diagnostic.",
  unavailable: "Check that the local Tailscale CLI and service are available; their state is unverified.",
  unknown: "Check local Tailscale status with the owner; its state could not be classified.",
  timeout: "Check local Tailscale service responsiveness, then rerun this diagnostic.",
};

function publicRoute(env) {
  const supplied = BASE_KEYS.filter((key) => env[key] !== undefined);
  if (supplied.length === 0) return "unconfigured";
  if (supplied.some((key) => typeof env[key] !== "string" || env[key] === "")) {
    return "invalid_configuration";
  }
  const trim = (value) => value.replace(/\/$/, "");
  let gateway;
  let openai;
  // Match m5-auth normalization and first-class precedence over the legacy alias.
  if (env.M5_GATEWAY_URL !== undefined) {
    gateway = trim(env.M5_GATEWAY_URL);
    openai = env.M5_OPENAI_BASE_URL ?? `${gateway}/v1`;
  } else {
    openai = trim(env.M5_OPENAI_BASE_URL ?? env.M5_BASE_URL);
    gateway = openai.replace(/\/v1$/, "");
  }
  gateway = trim(gateway);
  openai = trim(openai);
  return /^https?:\/\/[^/?#]+$/.test(gateway) && !gateway.endsWith("/v1") &&
    openai === `${gateway}/v1` ? "configured" : "invalid_configuration";
}

function runLocalStatus(runStatus) {
  return runStatus("tailscale", ["status", "--json"], {
    encoding: "utf8",
    timeout: 3000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    // The status child needs PATH, not inherited gateway tokens or Node hook options.
    env: { PATH: process.env.PATH ?? "" },
  });
}

function tailscaleState(runStatus) {
  let result;
  try {
    result = runLocalStatus(runStatus);
  } catch (error) {
    return error?.code === "ETIMEDOUT" ? "timeout" : "unavailable";
  }
  if (result?.error?.code === "ETIMEDOUT") return "timeout";
  if (result?.error || result?.status !== 0 || result?.signal) return "unavailable";
  try {
    const parsed = JSON.parse(result.stdout);
    return STATES.get(parsed?.BackendState) ?? "unknown";
  } catch {
    // Invalid status is evidence of an unknown state, not evidence of a stopped daemon.
    return "unknown";
  }
}

export function diagnoseLocalNetwork({ env = {}, runStatus = spawnSync } = {}) {
  const publicStatus = publicRoute(env);
  const tailscale = tailscaleState(runStatus);
  return {
    schema_version: 1,
    scope: "local_network_only",
    public_route: publicStatus,
    tailscale,
    gateway_reachability: "not_checked",
    credential: "not_checked",
    connector_session: "not_inspected",
    remediation: [ACTIONS[publicStatus], ACTIONS[tailscale]].filter(Boolean),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write("Usage: node bin/m5-network-doctor.mjs\nReports local route prerequisites only; no credential or gateway checks.\n");
  } else if (args.length !== 0) {
    process.stderr.write("m5-network-doctor: unexpected arguments; use --help.\n");
    process.exitCode = 2;
  } else {
    const env = Object.fromEntries(BASE_KEYS.map((key) => [key, process.env[key]]));
    process.stdout.write(`${JSON.stringify(diagnoseLocalNetwork({ env }))}\n`);
  }
}
