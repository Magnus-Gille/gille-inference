import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_LINE = 128 * 1024; // 48 KiB worker chunks become 64 KiB + JSON framing.
const MAX_PULL_FILE = 16 * 1024 * 1024;
const MAX_PULL_TOTAL = 32 * 1024 * 1024;
const MAX_CAPACITY_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_FILESYSTEM_BYTES = 64 * 1024 ** 3;
const MAX_STATUS_BYTES = 512 * 1024;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHANNEL = /^(?:\d+\.\d+(?:\.\d+)?|stable)$/;
const FILE_HELPER = fileURLToPath(new URL("./m5-build-files.py", import.meta.url));
const LOCAL_ENV = { PATH: "/usr/bin:/bin:/opt/homebrew/bin", LANG: "C.UTF-8" };

/**
 * An error from this client with a stable machine-readable code. Only errors created here are
 * shown to an MCP caller with their message, so every message passed to this function must be a
 * fixed sentence, optionally with validated capacity integers: no paths, host locators,
 * subprocess output or free-form remote text. Untagged errors
 * (for example a filesystem-helper diagnostic) reach an MCP caller as a generic `build_failed`.
 */
function buildError(code, message) {
  return Object.assign(new Error(message), { buildCode: code });
}

export function defaultBuildConfigPath() {
  return join(homedir(), ".config", "m5", "build.json");
}

export async function loadBuildConfig(path = defaultBuildConfigPath(), { allowDefault = false } = {}) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (allowDefault && error.code === "ENOENT") return { version: 1, sshTarget: "m5-build" };
    throw new Error("No readable local m5 build configuration is available.");
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid local m5 build configuration JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(key => key !== "version" && key !== "sshTarget")) {
    throw new Error("m5 build config must use version 1 and contain only sshTarget.");
  }
  const config = { version: 1, sshTarget: value.sshTarget ?? "m5-build" };
  if (typeof config.sshTarget !== "string" || !HOST.test(config.sshTarget)) {
    throw new Error("m5 build config must use a safe SSH host alias; set the dedicated user in SSH config.");
  }
  return config;
}

function safeRelative(path) {
  return typeof path === "string" && path.length > 0 && Buffer.byteLength(path) <= 4096 &&
    !path.includes("\\") && !path.includes("\0") &&
    !path.split("/").some(part => !part || part === "." || part === ".." ||
      [".git", "secrets"].includes(part.toLowerCase()) || part.toLowerCase().startsWith(".env"));
}

async function fileHelper(operation, request, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", FILE_HELPER, operation], {
      env: LOCAL_ENV, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = []; let bytes = 0; let diagnostic = ""; let failure;
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = new Error("Local build helper output exceeded its bound."); child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => {
      if (diagnostic.length < 1024) diagnostic += chunk.toString("utf8").slice(0, 1024 - diagnostic.length);
    });
    child.stdin.on("error", () => { failure = new Error("Local build filesystem helper stopped early."); });
    child.on("error", () => reject(new Error("m5 build needs Python 3, Git and OpenSSH locally; no unsafe filesystem fallback.")));
    child.on("close", code => {
      if (code === 0 && !failure) resolve(Buffer.concat(chunks));
      else reject(failure ?? new Error(diagnostic.trim() || "Local build filesystem helper failed."));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function createBuildArchive(cwd = process.cwd(), pull = []) {
  if (!Array.isArray(pull) || pull.length > 32 || new Set(pull).size !== pull.length || pull.some(path => !safeRelative(path))) {
    throw buildError("build_invalid_request", "Pull paths must be distinct safe relative file paths (at most 32).");
  }
  const response = await fileHelper("snapshot", { cwd, pull }, MAX_ARCHIVE + 8192);
  const newline = response.indexOf(10);
  if (newline < 0 || newline > 8192) throw new Error("Invalid local snapshot metadata.");
  const metadata = JSON.parse(response.subarray(0, newline).toString("utf8"));
  return { ...metadata, archive: response.subarray(newline + 1), pull };
}

function selectToolchain(prepared, explicit, command) {
  const executable = command[0].split("/").at(-1);
  if (executable !== "cargo") {
    if (explicit !== undefined) throw buildError("build_invalid_request", "--toolchain applies only to cargo commands.");
    return undefined;
  }
  let channel = explicit;
  if (channel === undefined && prepared.toolchainFile !== null) {
    const text = prepared.toolchainFile;
    const matches = [...text.matchAll(/^\s*channel\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/gm)];
    if (matches.length !== 1 || text.split(/\r?\n/).some(line => /^\s*channel\s*=/.test(line) && !/^\s*channel\s*=\s*["'][^"']+["']\s*(?:#.*)?$/.test(line))) {
      throw buildError("build_invalid_request", "Unsupported rust-toolchain.toml; pass --toolchain explicitly.");
    }
    channel = matches[0][1];
  } else if (channel === undefined && prepared.plainToolchain !== null) {
    channel = prepared.plainToolchain.trim();
  }
  if (channel !== undefined && (typeof channel !== "string" || !CHANNEL.test(channel))) {
    throw buildError("build_invalid_request", "Use a preinstalled numeric Rust toolchain or stable.");
  }
  if (channel !== undefined && command[1]?.startsWith("+")) throw buildError("build_invalid_request", "Do not combine --toolchain/repo toolchain with cargo +toolchain.");
  // Without a repo pin, use the immutable image's default, never install online.
  return channel;
}

function validateCommand(command) {
  if (!Array.isArray(command) || !command.length || command.length > 128 || !command[0] ||
      command.some(value => typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4096)) {
    throw buildError("build_invalid_request", "Build command must be a bounded literal argv array.");
  }
  const executable = command[0].split("/").at(-1);
  if (["xcrun", "xcodebuild", "swift", "codesign", "notarytool", "productbuild"].includes(executable) ||
      command.some(arg => arg.includes("apple-darwin") || arg.includes("apple-ios")) ||
      (executable === "cargo" && command.includes("tauri") && command.includes("build"))) {
    throw buildError("build_macos_only", "macOS-only job: use your Mac or a GitHub macOS runner.");
  }
}

function decodeData(value) {
  if (typeof value !== "string") throw new Error("Invalid build worker data.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.length > 48 * 1024) throw new Error("Invalid build worker data.");
  return decoded;
}

function validateCapacity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "capacity" ||
      Object.keys(value).some(key => !["type", "total_bytes", "used_bytes", "free_bytes",
        "minimum_free_bytes", "warning_free_bytes", "observed_at"].includes(key))) {
    throw new Error("Invalid build capacity record.");
  }
  for (const key of ["total_bytes", "used_bytes", "free_bytes", "minimum_free_bytes", "warning_free_bytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > MAX_CAPACITY_VALUE) {
      throw new Error("Invalid build capacity record.");
    }
  }
  const observedAt = typeof value.observed_at === "string" && Date.parse(value.observed_at);
  if (value.used_bytes > value.total_bytes || value.free_bytes > value.total_bytes ||
      value.used_bytes + value.free_bytes > value.total_bytes ||
      value.minimum_free_bytes > value.warning_free_bytes || value.warning_free_bytes > MAX_FILESYSTEM_BYTES ||
      value.total_bytes > MAX_FILESYSTEM_BYTES ||
      typeof value.observed_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.observed_at) ||
      !Number.isFinite(observedAt) || new Date(observedAt).toISOString().replace(".000Z", "Z") !== value.observed_at) {
    throw new Error("Invalid build capacity record.");
  }
  return {
    total_bytes: value.total_bytes, used_bytes: value.used_bytes, free_bytes: value.free_bytes,
    minimum_free_bytes: value.minimum_free_bytes, warning_free_bytes: value.warning_free_bytes,
    observed_at: value.observed_at,
  };
}

function workerArgs(target) {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "SendEnv=-*",
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2", "-T", target, "m5-build-worker"];
}

function workerEnv() { return { ...LOCAL_ENV, HOME: homedir() }; }

export async function getBuildStatus({ config, spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  const build = config ?? await loadBuildConfig(defaultBuildConfigPath(), { allowDefault: true });
  if (typeof build.sshTarget !== "string" || !HOST.test(build.sshTarget)) throw new Error("Unsafe m5 build SSH target.");
  const child = spawnImpl("ssh", workerArgs(build.sshTarget), {
    env: workerEnv(), stdio: ["pipe", "pipe", "pipe"],
  });
  let lineBuffer = Buffer.alloc(0); let capacity; let remoteExit; let protocolError; let wireBytes = 0;
  const abort = error => { protocolError ??= error; child.kill(); };
  const timer = setTimeout(() => abort(buildError("build_timeout", "Remote build status timed out; check dedicated worker availability.")), timeoutMs);
  timer.unref?.();
  child.stderr.on("data", () => {});
  child.stdin.on?.("error", () => abort(new Error("SSH build status request failed; no local fallback.")));
  function consume(line) {
    const message = JSON.parse(line.toString("utf8"));
    if (!message || typeof message !== "object" || Array.isArray(message) || remoteExit !== undefined || protocolError) {
      throw new Error("Trailing or malformed build status protocol message.");
    }
    if (message.type === "capacity") {
      if (capacity) throw new Error("Duplicate build capacity record.");
      capacity = validateCapacity(message);
    } else if (message.type === "exit" && Number.isInteger(message.code) && message.code >= 0 && message.code <= 255) {
      if (!capacity || message.code !== 0) throw new Error("Incomplete build status protocol.");
      remoteExit = message.code;
    } else if (message.type === "error" && message.code === 125 && typeof message.message === "string") {
      throw buildError("build_worker_failure", "Build status worker refused the request; verify dedicated worker provisioning.");
    } else throw new Error("Malformed build status protocol.");
  }
  child.stdout.on("data", chunk => {
    if (protocolError) return;
    wireBytes += chunk.length;
    if (wireBytes > MAX_STATUS_BYTES) {
      abort(buildError("build_protocol_error", "Invalid remote build status protocol."));
      return;
    }
    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    try {
      let newline;
      while ((newline = lineBuffer.indexOf(10)) >= 0) {
        if (newline > MAX_LINE) throw new Error("Build status protocol line exceeds its bound.");
        consume(lineBuffer.subarray(0, newline));
        lineBuffer = lineBuffer.subarray(newline + 1);
      }
      if (lineBuffer.length > MAX_LINE) throw new Error("Build status protocol line exceeds its bound.");
    } catch (error) { abort(error?.buildCode === "build_worker_failure" ? error : buildError("build_protocol_error", "Invalid remote build status protocol.")); }
  });
  try {
    const completion = new Promise((resolve, reject) => {
      child.on("error", () => reject(new Error("Could not launch SSH build status transport.")));
      child.on("close", code => resolve(code ?? 125));
    });
    child.stdin.write(JSON.stringify({ version: 1, operation: "status" }) + "\n");
    child.stdin.end();
    const sshExit = await completion;
    if (protocolError || lineBuffer.length || !capacity || remoteExit === undefined || sshExit !== remoteExit) {
      throw protocolError ?? buildError("build_protocol_error", "Build status ended without a matching remote exit record.");
    }
    return capacity;
  } finally { clearTimeout(timer); }
}

export async function runBuild({ cwd = process.cwd(), command, pull = [], toolchain, config,
  spawnImpl = spawn, outputLimit = Infinity, stdout = process.stdout, stderr = process.stderr,
  captureOutput = false, timeoutMs = 31 * 60 * 1000 }) {
  validateCommand(command);
  const build = config ?? await loadBuildConfig(defaultBuildConfigPath(), { allowDefault: true });
  if (typeof build.sshTarget !== "string" || !HOST.test(build.sshTarget)) throw new Error("Unsafe m5 build SSH target.");
  const prepared = await createBuildArchive(cwd, pull);
  const selected = selectToolchain(prepared, toolchain, command);
  const request = { version: 1, repo_id: prepared.repoId, worktree_id: prepared.worktreeId,
    command, ...(selected === undefined ? {} : { toolchain: selected }), pull, archive_bytes: prepared.archive.length };
  const requestLine = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(requestLine) > 8192) throw new Error("Build header exceeds its 8192-byte limit.");
  const child = spawnImpl("ssh", workerArgs(build.sshTarget), {
    env: workerEnv(), stdio: ["pipe", "pipe", "pipe"],
  });
  let lineBuffer = Buffer.alloc(0); let remoteExit; let protocolError; let workerFailure = false;
  let capacity; let sawRecord = false; let uploadError;
  const totals = { stdout: 0, stderr: 0 }; const truncated = { stdout: false, stderr: false };
  const captured = { stdout: [], stderr: [] }; const artifacts = new Map(); let pullTotal = 0;
  const abort = error => { protocolError ??= error; child.kill(); };
  const timer = setTimeout(() => abort(buildError("build_timeout", "Remote build timed out; check dedicated worker cleanup.")), timeoutMs);
  timer.unref?.();
  // Consume but never print SSH diagnostics: they may contain private locators.
  child.stderr.on("data", () => {});
  // A worker can refuse before consuming the archive. Drain its bounded stdout
  // before choosing between the content-free refusal and an upload failure.
  child.stdin.on?.("error", () => { uploadError ??= new Error("SSH build upload failed; no local fallback."); });
  function consume(line) {
    const message = JSON.parse(line.toString("utf8"));
    if (!message || typeof message !== "object" || Array.isArray(message) || remoteExit !== undefined || workerFailure) {
      throw new Error("Trailing or malformed build protocol message.");
    }
    if (message.type === "capacity") {
      if (capacity || sawRecord) throw new Error("Duplicate or late build capacity record.");
      capacity = validateCapacity(message);
      sawRecord = true;
    } else if (message.type === "stdout" || message.type === "stderr") {
      sawRecord = true;
      const data = decodeData(message.data);
      const kind = message.type; const room = Math.max(0, outputLimit - totals[kind]);
      const emitted = data.subarray(0, room);
      if (emitted.length) {
        (kind === "stdout" ? stdout : stderr).write(emitted);
        if (captureOutput) captured[kind].push(emitted);
      }
      totals[kind] += emitted.length;
      truncated[kind] ||= emitted.length < data.length;
    } else if (message.type === "artifact") {
      sawRecord = true;
      if (!safeRelative(message.path) || !pull.includes(message.path)) throw new Error("Unrequested or unsafe build artifact.");
      const data = decodeData(message.data); const entry = artifacts.get(message.path) ?? { bytes: 0, chunks: [] };
      entry.bytes += data.length; pullTotal += data.length;
      if (entry.bytes > MAX_PULL_FILE || pullTotal > MAX_PULL_TOTAL) throw new Error("Build artifacts exceed their bound.");
      entry.chunks.push(data); artifacts.set(message.path, entry);
    } else if (message.type === "exit" && Number.isInteger(message.code) && message.code >= 0 && message.code <= 255) {
      sawRecord = true;
      remoteExit = message.code;
    } else if (message.type === "error" && message.code === 125 && message.diagnostic_code === "build_capacity_low" && !capacity) {
      throw new Error("Invalid build capacity refusal.");
    } else if (message.type === "error" && message.code === 125 && message.diagnostic_code === "build_capacity_low") {
      workerFailure = true;
      protocolError = buildError("build_capacity_low", `Remote build filesystem has ${capacity.free_bytes} bytes free of ${capacity.total_bytes}; at least ${capacity.minimum_free_bytes} bytes free are required. Check m5 build status and request scoped cleanup.`);
    } else if (message.type === "error" && message.code === 125 && typeof message.message === "string") {
      sawRecord = true;
      workerFailure = true;
      // Do not trust a compromised remote process to provide safe free-form diagnostics.
      protocolError = buildError("build_worker_failure", "Build worker infrastructure failure; verify dedicated host, offline caches and resource limits.");
    } else throw new Error("Malformed build worker protocol.");
  }
  child.stdout.on("data", chunk => {
    if (protocolError) return;
    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    try {
      let newline;
      while ((newline = lineBuffer.indexOf(10)) >= 0) {
        if (newline > MAX_LINE) throw new Error("Build protocol line exceeds its bound.");
        consume(lineBuffer.subarray(0, newline));
        lineBuffer = lineBuffer.subarray(newline + 1);
      }
      if (lineBuffer.length > MAX_LINE) throw new Error("Build protocol line exceeds its bound.");
    } catch (error) { abort(buildError("build_protocol_error", "Invalid remote build protocol.")); }
  });
  try {
    const completion = new Promise((resolve, reject) => {
      child.on("error", () => reject(new Error("Could not launch SSH build transport.")));
      child.on("close", code => resolve(code ?? 125));
    });
    child.stdin.write(requestLine); child.stdin.write(prepared.archive); child.stdin.end();
    const sshExit = await completion;
    if (protocolError || uploadError || lineBuffer.length || remoteExit === undefined || sshExit !== remoteExit) {
      throw protocolError ?? uploadError ?? buildError("build_protocol_error", "Build ended without a matching remote exit record.");
    }
    if (pull.some(path => !artifacts.has(path))) throw new Error("Worker did not return every selected artifact.");
    if (artifacts.size) {
      await fileHelper("pull", { root: prepared.root, artifacts: [...artifacts].map(([path, entry]) => ({
        path, data: Buffer.concat(entry.chunks).toString("base64"),
      })) }, 1024);
    }
    return { exit_code: remoteExit, ...(capacity ? { capacity } : {}), truncated, ...(captureOutput ? {
      stdout: Buffer.concat(captured.stdout).toString("utf8"), stderr: Buffer.concat(captured.stderr).toString("utf8"),
    } : {}) };
  } finally { clearTimeout(timer); }
}

export function parseBuildArgs(args) {
  const pull = []; let toolchain; let index = 0;
  while (index < args.length && args[index] !== "--") {
    const arg = args[index++];
    if (arg === "--pull") {
      if (!args[index] || args[index] === "--") throw new Error("--pull requires a relative file path.");
      pull.push(args[index++]);
    } else if (arg === "--toolchain") {
      if (toolchain !== undefined || !args[index] || args[index] === "--") throw new Error("--toolchain requires one version.");
      toolchain = args[index++];
    } else throw new Error("Unknown build option; options precede the -- separator.");
  }
  if (args[index] !== "--" || index === args.length - 1) {
    throw new Error("Usage: m5 build [--pull relative/file] [--toolchain version] -- command args");
  }
  return { pull, toolchain, command: args.slice(index + 1) };
}
