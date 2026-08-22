#!/usr/bin/env -S node --import tsx

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type OxMode = "readonly" | "write";
export type OxThinking = "low" | "high" | "max";
export type OxOutputMode = "text" | "json";

export interface OxAgentOptions {
  mode: OxMode;
  thinking: OxThinking;
  timeoutSeconds: number;
  outputMode: OxOutputMode;
  dryRun: boolean;
  prompt: string;
}

export interface PiInvocation {
  prompt: string;
  thinking: OxThinking;
  outputMode: OxOutputMode;
  extensionPath: string;
  configDir: string;
  tools: string;
}

export interface CredentialProxy {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

const USAGE = `Usage: npm run agent:ox -- [options] <prompt>

Runs Nous stealth/ox-alpha through headless Pi with isolated subagents.

Options:
  --read-only          Read-only root and read-only subagents (default)
  --write              Enable root write tools and the bounded ox-worker subagent
  --thinking LEVEL     low, high, or max (default: max)
  --timeout SECONDS    Wall-clock limit, 10-3600 (default: 600)
  --json               Emit Pi JSONL instead of final text
  --dry-run            Print resolved non-secret configuration and exit
  -h, --help           Show this help

The prompt may be piped on stdin. NOUS_API_KEY may be supplied through a secret
facility; otherwise an interactive terminal prompts for it without echo.`;

export function parseOxAgentArgs(argv: string[]): OxAgentOptions {
  let mode: OxMode = "readonly";
  let thinking: OxThinking = "max";
  let timeoutSeconds = 600;
  let outputMode: OxOutputMode = "text";
  let dryRun = false;
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      promptParts.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--read-only") mode = "readonly";
    else if (arg === "--write") mode = "write";
    else if (arg === "--json") outputMode = "json";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "-h" || arg === "--help") throw new HelpRequested();
    else if (arg === "--thinking") {
      const value = argv[++index];
      if (value !== "low" && value !== "high" && value !== "max") {
        throw new Error("--thinking must be low, high, or max");
      }
      thinking = value;
    } else if (arg === "--timeout") {
      timeoutSeconds = Number(argv[++index]);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      promptParts.push(arg);
    }
  }

  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
    throw new Error("--timeout must be an integer from 10 to 3600 seconds");
  }

  return {
    mode,
    thinking,
    timeoutSeconds,
    outputMode,
    dryRun,
    prompt: promptParts.join(" ").trim(),
  };
}

class HelpRequested extends Error {}

export function profilePaths(repoRoot: string, mode: OxMode): { configDir: string; tools: string } {
  return {
    configDir: path.join(repoRoot, "config", "ox-alpha-pi", mode),
    tools:
      mode === "write"
        ? "read,bash,edit,write,grep,find,ls,subagent"
        : "read,grep,find,ls,subagent",
  };
}

export function buildPiArgs(input: PiInvocation): string[] {
  return [
    "--provider",
    "nous",
    "--model",
    "stealth/ox-alpha",
    "--thinking",
    input.thinking,
    "--extension",
    input.extensionPath,
    "--tools",
    input.tools,
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--mode",
    input.outputMode,
    "--print",
    input.prompt,
  ];
}

function findOnPath(command: string, envPath = process.env.PATH): string {
  if (command.includes(path.sep)) return command;
  for (const directory of (envPath ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`Could not find ${command} on PATH`);
}

export function locateSubagentExtension(piBinary: string): string {
  const realPi = realpathSync(piBinary);
  const packageRoot = path.dirname(path.dirname(realPi));
  const extension = path.join(packageRoot, "examples", "extensions", "subagent", "index.ts");
  if (!existsSync(extension)) {
    throw new Error(
      `Pi's bundled subagent extension was not found at ${extension}. ` +
        "Install @earendil-works/pi-coding-agent 0.84.x or set OX_PI_SUBAGENT_EXTENSION.",
    );
  }
  return realpathSync(extension);
}

export function childEnvironment(
  source: NodeJS.ProcessEnv,
  configDir: string,
  proxyToken: string,
): NodeJS.ProcessEnv {
  const env = {
    ...source,
    PI_CODING_AGENT_DIR: configDir,
    OX_PI_PROXY_TOKEN: proxyToken,
  };
  delete env.NOUS_API_KEY;
  return env;
}

export function prepareRuntimeConfig(
  sourceConfigDir: string,
  proxyBaseUrl: string,
): { configDir: string; cleanup(): void } {
  const configDir = mkdtempSync(path.join(tmpdir(), "ox-alpha-pi-runtime-"));
  try {
    const parsed = JSON.parse(readFileSync(path.join(sourceConfigDir, "models.json"), "utf8")) as {
      providers?: { nous?: { baseUrl?: string; apiKey?: string } };
    };
    const provider = parsed.providers?.nous;
    if (!provider) throw new Error("Ox Alpha profile is missing providers.nous");
    provider.baseUrl = proxyBaseUrl;
    provider.apiKey = "$OX_PI_PROXY_TOKEN";
    writeFileSync(path.join(configDir, "models.json"), `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    cpSync(path.join(sourceConfigDir, "agents"), path.join(configDir, "agents"), {
      recursive: true,
    });
  } catch (error) {
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
  return {
    configDir,
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readRequestBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("request body exceeds 64 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function startCredentialProxy(options: {
  upstreamBaseUrl: string;
  apiKey: string;
}): Promise<CredentialProxy> {
  const token = randomBytes(32).toString("hex");
  const upstreamUrl = `${options.upstreamBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const activeControllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    let controller: AbortController | undefined;
    let onClientClose: (() => void) | undefined;
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        response.writeHead(401).end();
        return;
      }

      controller = new AbortController();
      activeControllers.add(controller);
      request.once("aborted", () => controller?.abort());
      onClientClose = () => {
        if (!response.writableEnded) controller?.abort();
      };
      response.once("close", onClientClose);
      const body = await readRequestBody(request);
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          accept: request.headers.accept ?? "application/json",
          authorization: `Bearer ${options.apiKey}`,
          "content-type": request.headers["content-type"] ?? "application/json",
        },
        body,
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "cache-control", "x-request-id"]) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(upstream.status, headers);
      if (upstream.body) {
        for await (const chunk of upstream.body) response.write(Buffer.from(chunk));
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof Error && error.message.includes("64 MiB") ? 413 : 502;
        response.writeHead(status, { "content-type": "application/json" });
      }
      response.end('{"error":{"message":"credential proxy request failed"}}');
    } finally {
      if (onClientClose) response.off("close", onClientClose);
      if (controller) activeControllers.delete(controller);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Credential proxy did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: async () => {
      for (const controller of activeControllers) controller.abort();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input.trim()));
    process.stdin.on("error", reject);
  });
}

function resolveApiKey(): string {
  const configured = process.env.NOUS_API_KEY?.trim();
  if (configured) return configured;

  let ttyFd: number;
  try {
    ttyFd = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("NOUS_API_KEY is required when no interactive terminal is available");
  }

  try {
    const result = spawnSync(
      "/bin/zsh",
      ["-c", 'read -r -s "value?Nous API key (hidden): "; printf "\\n" >/dev/tty; printf "%s" "$value"'],
      { encoding: "utf8", stdio: [ttyFd, "pipe", ttyFd] },
    );
    if (result.status !== 0) throw new Error("Could not read Nous API key from the terminal");
    const key = result.stdout.trim();
    if (!key) throw new Error("Nous API key cannot be empty");
    return key;
  } finally {
    closeSync(ttyFd);
  }
}

export async function runPi(options: {
  piBinary: string;
  args: string[];
  configDir: string;
  proxyToken: string;
  timeoutSeconds: number;
}): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(options.piBinary, options.args, {
      cwd: process.cwd(),
      env: childEnvironment(process.env, options.configDir, options.proxyToken),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outputLimit = 2 * 1024 * 1024;
    let outputBytes = 0;
    let termination: "timeout" | "output" | "signal" | undefined;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const terminate = (reason: typeof termination, signal: NodeJS.Signals = "SIGTERM"): void => {
      if (termination) return;
      termination = reason;
      signalGroup(signal);
      forceTimer = setTimeout(() => signalGroup("SIGKILL"), 3_000);
      forceTimer.unref();
    };

    const forward = (stream: NodeJS.ReadableStream, destination: NodeJS.WritableStream): void => {
      stream.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) {
          process.stderr.write("\nox-agent: output exceeded 2 MiB; terminating process group\n");
          terminate("output");
          return;
        }
        destination.write(chunk);
      });
    };

    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    const timeout = setTimeout(() => {
      process.stderr.write(
        `\nox-agent: timed out after ${options.timeoutSeconds}s; terminating process group\n`,
      );
      terminate("timeout");
    }, options.timeoutSeconds * 1_000);
    timeout.unref();

    const onSigint = (): void => terminate("signal", "SIGINT");
    const onSigterm = (): void => terminate("signal", "SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(code);
    };

    child.once("error", (error) => {
      process.stderr.write(`ox-agent: failed to start Pi: ${error.message}\n`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (termination) signalGroup("SIGKILL");
      if (termination === "timeout") finish(124);
      else if (termination === "output") finish(125);
      else if (termination === "signal" || signal) finish(130);
      else finish(code ?? 1);
    });
  });
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: OxAgentOptions;
  try {
    options = parseOxAgentArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  const root = repoRoot();
  const profile = profilePaths(root, options.mode);
  const piBinary = findOnPath(process.env.OX_PI_BIN ?? "pi");
  const extensionPath = process.env.OX_PI_SUBAGENT_EXTENSION
    ? realpathSync(process.env.OX_PI_SUBAGENT_EXTENSION)
    : locateSubagentExtension(piBinary);

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          provider: "nous",
          model: "stealth/ox-alpha",
          thinking: options.thinking,
          timeoutSeconds: options.timeoutSeconds,
          outputMode: options.outputMode,
          mode: options.mode,
          configDir: profile.configDir,
          extensionPath,
          tools: profile.tools,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const prompt = options.prompt || (!process.stdin.isTTY ? await readStdin() : "");
  if (!prompt) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const apiKey = resolveApiKey();
  delete process.env.NOUS_API_KEY;
  const proxy = await startCredentialProxy({
    upstreamBaseUrl: "https://inference-api.nousresearch.com/v1",
    apiKey,
  });
  let runtime: ReturnType<typeof prepareRuntimeConfig> | undefined;
  try {
    runtime = prepareRuntimeConfig(profile.configDir, proxy.baseUrl);
    const args = buildPiArgs({
      prompt,
      thinking: options.thinking,
      outputMode: options.outputMode,
      extensionPath,
      configDir: runtime.configDir,
      tools: profile.tools,
    });
    return await runPi({
      piBinary,
      args,
      configDir: runtime.configDir,
      proxyToken: proxy.token,
      timeoutSeconds: options.timeoutSeconds,
    });
  } finally {
    runtime?.cleanup();
    await proxy.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
