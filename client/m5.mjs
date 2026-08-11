#!/usr/bin/env node
/**
 * m5 — secret-safe owner-agent client for the Gille Inference gateway.
 *
 * Credentials are resolved internally from macOS Keychain profile accounts. This command
 * deliberately has no key/token/environment/config/argv credential input.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  M5_CLIENT_VERSION,
  M5ClientError,
  createKeychainCredentialStore,
  createM5Client,
  diagnoseProfile,
  redactText,
  validateProfileConfig,
} from "./m5-client.mjs";
import { provisionProfile } from "./m5-provision.mjs";
import { createMcpStdioBridge, runMcpStdioBridge } from "./m5-stdio-bridge.mjs";

const MAX_STDIN_BYTES = 3 * 1024 * 1024;

export function defaultConfigPath() {
  return join(homedir(), ".config", "m5", "config.json");
}

export function loadM5Config(path = defaultConfigPath()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new M5ClientError(
      "missing_config",
      "No valid m5 profile configuration is available.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    !parsed.profiles ||
    typeof parsed.profiles !== "object"
  ) {
    throw new M5ClientError(
      "invalid_config",
      "m5 config must use version 1 and contain a profiles object.",
    );
  }
  return parsed;
}

function parseGlobalArgs(argv) {
  let profile;
  let endpoint = "public";
  let privateRequested = false;
  let publicGatewayUrl;
  let sshTarget;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new M5ClientError("invalid_args", "--profile requires a profile name.");
      }
      profile = value;
      index += 1;
    } else if (arg === "--private") {
      endpoint = "private";
      privateRequested = true;
    } else if (arg === "--public") {
      endpoint = "public";
    } else if (arg === "--public-gateway-url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new M5ClientError("invalid_args", "--public-gateway-url requires an HTTPS URL.");
      }
      publicGatewayUrl = value;
      index += 1;
    } else if (arg === "--m5-host") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new M5ClientError("invalid_args", "--m5-host requires an SSH host or user@host value.");
      }
      sshTarget = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      positional.push("help");
    } else if (arg === "--version" || arg === "-v") {
      positional.push("version");
    } else {
      positional.push(arg);
    }
  }
  return { profile, endpoint, privateRequested, positional, publicGatewayUrl, sshTarget };
}

async function readBoundedInput(input) {
  input.setEncoding?.("utf8");
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    if (Buffer.byteLength(text, "utf8") > MAX_STDIN_BYTES) {
      throw new M5ClientError(
        "input_too_large",
        "Structured JSON input exceeds the 3 MiB client limit.",
      );
    }
  }
  if (text.trim() === "") {
    throw new M5ClientError("invalid_input", "Structured JSON input is required on stdin.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new M5ClientError("invalid_input", "stdin must contain one valid JSON value.");
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeDeployEnv(stream, publicGatewayUrl) {
  const publicHttpUrl = new URL(publicGatewayUrl);
  publicHttpUrl.protocol = "http:";
  stream.write([
    "unset M5_API_KEY HOMESERVER_OWNER_KEY \\",
    "  DEPLOY_HEALTH_TAILNET_URL DEPLOY_CAPABILITY_URL \\",
    "  DEPLOY_PUBLIC_HTTP_URL DEPLOY_PUBLIC_HTTPS_URL &&",
    'eval "$(m5-auth --env --tailnet)" &&',
    'test -n "${M5_API_KEY:-}" &&',
    'export HOMESERVER_OWNER_KEY="$M5_API_KEY" &&',
    "unset M5_API_KEY &&",
    'export DEPLOY_HEALTH_TAILNET_URL="${M5_GATEWAY_URL%/}/healthz" &&',
    'export DEPLOY_CAPABILITY_URL="${M5_GATEWAY_URL%/}/v1/capabilities/learning-task" &&',
    `export DEPLOY_PUBLIC_HTTP_URL=${shellQuote(publicHttpUrl.origin)} &&`,
    `export DEPLOY_PUBLIC_HTTPS_URL=${shellQuote(publicGatewayUrl)}`,
    "",
  ].join("\n"));
}

function help() {
  return {
    name: "m5",
    version: M5_CLIENT_VERSION,
    usage: [
      "m5 --profile <claude|codex> doctor",
      "eval \"$(m5 --profile <name> deploy-env)\"",
      "m5 --profile <claude|codex> [--public|--private] mcp",
      "m5 --profile <claude|codex> [--public|--private] models",
      "printf '%s' '<json>' | m5 --profile <claude|codex> ask",
      "printf '%s' '<content-free-json>' | m5 --profile <claude|codex> adoption report",
      "printf '%s' '<json>' | m5 --profile <claude|codex> code run",
      "m5 --profile <claude|codex> code status <work_id>",
      "m5 --profile <claude|codex> code result <work_id>",
      "m5 --profile <name> --public-gateway-url <https-url> --m5-host <user@host> provision",
    ],
    credential_source: "macOS Keychain profile account (internal only)",
    security_boundary:
      "The gateway sandbox and diff-only server result are authoritative; CLI defaults are not enforcement.",
  };
}

function selectedProfile(config, profile) {
  if (!profile) {
    throw new M5ClientError(
      "profile_required",
      "--profile is required so Claude and Codex never share a credential implicitly.",
    );
  }
  const raw = config.profiles[profile];
  if (!raw) {
    throw new M5ClientError(
      "unknown_profile",
      "The selected profile is not present in m5 config.",
    );
  }
  return validateProfileConfig(raw);
}

export async function main(
  argv,
  {
    input = process.stdin,
    output = process.stdout,
    error = process.stderr,
    configLoader = loadM5Config,
    credentialStore = createKeychainCredentialStore(),
    fetch: fetchImpl = globalThis.fetch,
    bridgeRunner = runMcpStdioBridge,
    provisioner = provisionProfile,
  } = {},
) {
  try {
    const {
      profile,
      endpoint,
      privateRequested,
      positional,
      publicGatewayUrl,
      sshTarget,
    } = parseGlobalArgs(argv);
    const command = positional[0];
    if (!command || command === "help") {
      writeJson(output, help());
      return 0;
    }
    if (command === "version") {
      writeJson(output, { name: "m5", version: M5_CLIENT_VERSION });
      return 0;
    }

    if (command === "provision") {
      if (!profile) {
        throw new M5ClientError("profile_required", "--profile is required for provisioning.");
      }
      const provisioned = await provisioner({
        profile,
        publicGatewayUrl,
        sshTarget,
        configPath: defaultConfigPath(),
      });
      const result = await diagnoseProfile({
        profile,
        profileConfig: provisioned.profileConfig,
        credentialStore,
        fetch: fetchImpl,
      });
      writeJson(output, result);
      return result.status === "healthy" ? 0 : 1;
    }
    if (publicGatewayUrl !== undefined || sshTarget !== undefined) {
      throw new M5ClientError("invalid_args", "--public-gateway-url and --m5-host are only valid with provision.");
    }

    const config = configLoader();
    const profileConfig = selectedProfile(config, profile);
    if (command === "deploy-env") {
      if (privateRequested) {
        throw new M5ClientError(
          "invalid_args",
          "--private is not valid with deploy-env; tailnet URLs come from m5-auth.",
        );
      }
      writeDeployEnv(output, profileConfig.publicGatewayUrl);
      return 0;
    }
    if (command === "doctor") {
      const result = await diagnoseProfile({
        profile,
        profileConfig,
        credentialStore,
        fetch: fetchImpl,
      });
      writeJson(output, result);
      return result.status === "healthy" ? 0 : 1;
    }

    const gatewayUrl =
      endpoint === "private"
        ? profileConfig.privateGatewayUrl
        : profileConfig.publicGatewayUrl;
    if (!gatewayUrl) {
      throw new M5ClientError(
        "endpoint_not_configured",
        "The selected profile does not configure that gateway path.",
      );
    }
    const client = await createM5Client({
      gatewayUrl,
      endpoint,
      profile,
      credentialStore,
      fetch: fetchImpl,
    });

    if (command === "mcp") {
      const bridge = createMcpStdioBridge({ client });
      await bridgeRunner({ bridge, input, output });
      return 0;
    }
    if (command === "models") {
      writeJson(output, await client.models());
      return 0;
    }
    if (command === "ask") {
      writeJson(output, await client.ask(await readBoundedInput(input)));
      return 0;
    }
    if (command === "adoption") {
      if (positional[1] !== "report") {
        throw new M5ClientError("invalid_args", "adoption requires: report.");
      }
      writeJson(output, await client.reportAdoption(await readBoundedInput(input)));
      return 0;
    }
    if (command === "code") {
      const operation = positional[1];
      if (operation === "run") {
        writeJson(output, await client.codeRun(await readBoundedInput(input)));
        return 0;
      }
      if (operation === "status") {
        writeJson(output, await client.codeStatus(positional[2]));
        return 0;
      }
      if (operation === "result") {
        writeJson(output, await client.codeResult(positional[2]));
        return 0;
      }
      throw new M5ClientError(
        "invalid_args",
        "code requires one of: run, status, result.",
      );
    }
    throw new M5ClientError("invalid_args", "Unknown m5 command.");
  } catch (caught) {
    const safe =
      caught instanceof M5ClientError
        ? caught
        : new M5ClientError(
            "client_error",
            redactText(caught instanceof Error ? caught.message : "m5 failed."),
          );
    writeJson(error, safe.toJSON());
    return 1;
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("/m5.mjs") || process.argv[1].endsWith("/m5"));

if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
