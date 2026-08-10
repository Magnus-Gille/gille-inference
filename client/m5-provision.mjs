import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { M5ClientError, redactText, validateProfileConfig } from "./m5-client.mjs";

const KEYCHAIN_SERVICE = "gille-inference";
const KEY_PATTERN = /\bhs_owner_[A-Za-z0-9_-]+\b/g;
const SSH_TARGET = /^(?:[A-Za-z_][A-Za-z0-9_-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const COMMAND_TIMEOUT_GRACE_MS = 1_000;
const COMMAND_TIMEOUT_FINAL_GRACE_MS = 250;
const REVOCATION_ATTEMPTS = 3;
const REVOCATION_RETRY_DELAY_MS = 100;

// This script intentionally has no interpolation. The alias travels as $1, after validation.
const LIVE_KEY_COMMAND = String.raw`set -eu
alias="$1"
shift
pid=$(systemctl show home-gateway.service -p MainPID --value)
test "$pid" -gt 0
exec nsenter -t "$pid" -m -- sh -c '
  shift
  set -a
  . /etc/gille-inference/gateway/gateway.env
  set +a
  cd /home/magnus/home-server-eval
  exec /usr/sbin/runuser -u gille-gateway -- \
    /home/magnus/home-server-eval/node_modules/.bin/tsx src/homeserver/cli.ts \
    keys "$@"
' sh "$alias" "$@"
`;

function assertProfile(profile) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(profile ?? "")) {
    throw new M5ClientError("invalid_profile", "Profile names must contain only letters, digits, underscores, and hyphens.");
  }
}

function assertSshTarget(target) {
  if (typeof target !== "string" || !SSH_TARGET.test(target)) {
    throw new M5ClientError("invalid_ssh_target", "--m5-host must be a simple SSH host or user@host value.");
  }
}

function accountFor(profile) {
  return `gateway-agent-${profile.toLowerCase()}`;
}

function timestampAlias(profile, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `agent-${profile.toLowerCase()}-${stamp}`;
}

function outputError(command, code, stderr) {
  const detail = redactText(String(stderr ?? "").trim());
  return new M5ClientError(
    "provision_command_failed",
    `${command} failed${typeof code === "number" ? ` (exit ${code})` : ""}${detail ? `: ${detail}` : ""}`,
  );
}

/** Run a child without ever putting credential data in its argv or an error object. */
export function createCommandRunner({ spawn = nodeSpawn } = {}) {
  return function run(command, args, { input = "", timeoutMs = 20_000, captureStdout = true } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(new M5ClientError("provision_command_unavailable", redactText(error instanceof Error ? error.message : "Provisioning command is unavailable.")));
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let finished = false;
      let timedOut = false;
      let timeoutTimer;
      let killTimer;
      let finalGraceTimer;
      const clearTimers = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (finalGraceTimer) clearTimeout(finalGraceTimer);
        timeoutTimer = undefined;
        killTimer = undefined;
        finalGraceTimer = undefined;
      };
      const settleError = (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
      };
      const timeoutError = () => new M5ClientError("provision_command_timeout", `${command} did not finish within the bounded timeout.`);
      const onTimeout = () => {
        if (settled || finished) return;
        timedOut = true;
        timeoutTimer = undefined;
        try {
          child.kill("SIGTERM");
        } catch {
          // Continue waiting for close or the bounded SIGKILL/final grace path.
        }
        if (finished || settled) return;
        killTimer = setTimeout(() => {
          killTimer = undefined;
          if (finished || settled) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // Continue to the bounded final grace path even if the child is already gone.
          }
          if (finished || settled) return;
          finalGraceTimer = setTimeout(() => {
            finalGraceTimer = undefined;
            if (finished || settled) return;
            settleError(timeoutError());
          }, COMMAND_TIMEOUT_FINAL_GRACE_MS);
        }, COMMAND_TIMEOUT_GRACE_MS);
      };
      timeoutTimer = setTimeout(onTimeout, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (captureStdout) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        if (finished) return;
        if (!timedOut) settleError(new M5ClientError("provision_command_unavailable", redactText(error.message)));
      });
      child.on("close", (code, signal) => {
        finished = true;
        if (timedOut) {
          settleError(timeoutError());
          return;
        }
        clearTimers();
        if (!settled) {
          settled = true;
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });
      child.stdin.end(input);
    });
  };
}

function configFromFile(configPath) {
  if (!existsSync(configPath)) return { version: 1, profiles: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new M5ClientError("invalid_config", "m5 config is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
    throw new M5ClientError("invalid_config", "m5 config must use version 1 and contain a profiles object.");
  }
  return parsed;
}

export function ensureProvisionProfile({ configPath, profile, publicGatewayUrl }) {
  assertProfile(profile);
  const config = configFromFile(configPath);
  const existing = config.profiles[profile];
  if (existing) {
    const validated = validateProfileConfig(existing);
    if (publicGatewayUrl !== undefined && validated.publicGatewayUrl !== validateProfileConfig({ publicGatewayUrl }).publicGatewayUrl) {
      throw new M5ClientError("profile_url_conflict", "The existing profile has a different publicGatewayUrl; change it explicitly outside provisioning.");
    }
    return validated;
  }
  if (publicGatewayUrl === undefined) {
    throw new M5ClientError("public_url_required", "A new profile requires --public-gateway-url with an HTTPS URL.");
  }
  const profileConfig = validateProfileConfig({ publicGatewayUrl });
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  config.profiles[profile] = profileConfig;
  const temporary = join(dirname(configPath), `.config.json.provision-${process.pid}`);
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode });
  renameSync(temporary, configPath);
  return profileConfig;
}

async function keychainItemExists(run, account) {
  const result = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
    captureStdout: false,
    timeoutMs: 5_000,
  });
  if (result.code === 0) return true;
  if (result.code === 44) return false;
  throw outputError("Keychain lookup", result.code, result.stderr);
}

function onlyMintedKey(output) {
  const found = [...output.matchAll(KEY_PATTERN)].map((match) => match[0]);
  if (found.length !== 1) {
    throw new M5ClientError("mint_output_invalid", "The live mint command did not return exactly one owner credential.");
  }
  return found[0];
}

async function liveKeyCommand(run, sshTarget, alias, args) {
  const result = await run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes", sshTarget, "sudo -n /bin/sh -s --", alias, ...args],
    { input: LIVE_KEY_COMMAND, timeoutMs: 30_000 },
  );
  if (result.code !== 0) throw outputError("Live key command", result.code, result.stderr);
  return result.stdout;
}

async function revokeBestEffort(run, sshTarget, alias) {
  try {
    const stdout = await liveKeyCommand(run, sshTarget, alias, ["revoke", "--alias", alias]);
    return stdout.includes(`✓ revoked '${alias}'`);
  } catch {
    return false;
  }
}

const defaultWait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

async function revokeWithRetries(run, sshTarget, alias, { wait = defaultWait } = {}) {
  for (let attempt = 0; attempt < REVOCATION_ATTEMPTS; attempt += 1) {
    if (await revokeBestEffort(run, sshTarget, alias)) return true;
    if (attempt < REVOCATION_ATTEMPTS - 1) {
      try {
        await wait(REVOCATION_RETRY_DELAY_MS);
      } catch {
        // A failed delay must not prevent the remaining bounded cleanup attempts.
      }
    }
  }
  return false;
}

async function storeKeychainCredential(run, account, token) {
  // `script` provides the local pseudo-terminal required by security's prompt mode.
  // The secret is sent only on stdin, twice for its confirmation prompt, and never captured.
  const result = await run(
    "script",
    ["-q", "/dev/null", "/usr/bin/security", "add-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
    { input: `${token}\n${token}\n`, captureStdout: false, timeoutMs: 15_000 },
  );
  if (result.code !== 0) throw outputError("Keychain store", result.code, result.stderr);
}

/**
 * Provision a fresh owner-agent profile. Returns no bearer or alias so normal CLI output stays secret-safe.
 */
export async function provisionProfile({ profile, publicGatewayUrl, sshTarget, configPath, run = createCommandRunner(), now, wait = defaultWait } = {}) {
  assertProfile(profile);
  assertSshTarget(sshTarget);
  const profileConfig = ensureProvisionProfile({ configPath, profile, publicGatewayUrl });
  const account = accountFor(profile);
  if (await keychainItemExists(run, account)) {
    throw new M5ClientError("keychain_item_exists", `Keychain already has the credential for profile '${profile}'. Refuse provisioning until its ownership is reconciled.`);
  }
  const alias = timestampAlias(profile, now);
  let minted;
  try {
    minted = await liveKeyCommand(run, sshTarget, alias, ["mint", "--alias", alias, "--tier", "owner", "--scope", "agent"]);
  } catch {
    const revoked = await revokeWithRetries(run, sshTarget, alias, { wait });
    throw new M5ClientError(
      revoked ? "mint_failed_revoked" : "mint_failed_revocation_unknown",
      revoked
        ? "The live mint command failed; the newly minted credential was revoked."
        : "The live mint command failed and the newly minted credential could not be confirmed revoked; reconcile the live alias privately.",
    );
  }
  let token;
  try {
    token = onlyMintedKey(minted);
  } catch {
    const revoked = await revokeWithRetries(run, sshTarget, alias, { wait });
    throw new M5ClientError(
      revoked ? "mint_output_invalid_revoked" : "mint_output_invalid_revocation_unknown",
      revoked
        ? "The live mint output was invalid; the newly minted credential was revoked."
        : "The live mint output was invalid and the newly minted credential could not be confirmed revoked; reconcile the live alias privately.",
    );
  }
  try {
    await storeKeychainCredential(run, account, token);
  } catch (error) {
    const revoked = await revokeWithRetries(run, sshTarget, alias, { wait });
    throw new M5ClientError(
      revoked ? "keychain_store_failed_revoked" : "keychain_store_failed_revocation_unknown",
      revoked
        ? "Keychain storage failed; the newly minted credential was revoked."
        : "Keychain storage failed and the newly minted credential could not be confirmed revoked; reconcile the live alias privately.",
    );
  }
  return { profileConfig };
}
