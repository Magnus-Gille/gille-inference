import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_PULL_FILE = 16 * 1024 * 1024;
const MAX_PULL_TOTAL = 32 * 1024 * 1024;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REL = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;

export function defaultBuildConfigPath() { return join(homedir(), ".config", "m5", "build.json"); }

export async function loadBuildConfig(path = defaultBuildConfigPath()) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("No valid local m5 build configuration is available."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(key => key !== "version" && key !== "sshTarget")) {
    throw new Error("m5 build config must use version 1 and contain only sshTarget.");
  }
  const config = { version: 1, sshTarget: value.sshTarget ?? "m5-build" };
  if (typeof config.sshTarget !== "string" || !HOST.test(config.sshTarget)) throw new Error("m5 build config must use a safe SSH host or alias.");
  return config;
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
    const stdout = []; const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code: code ?? 125, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), child }));
    options.onSpawn?.(child);
  });
}

function safeRelative(path) {
  return typeof path === "string" && SAFE_REL.test(path) && path !== "." &&
    !path.split("/").some(part => !part || part === "." || part === ".." || part === ".git" || part === "secrets" || part.startsWith(".env"));
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

async function git(root, args, input) {
  const result = await run("git", ["-C", root, ...args]);
  if (result.code !== 0) throw new Error("Could not inspect the local git worktree safely.");
  return result.stdout;
}

async function gitCommonDir(root) {
  const raw = (await git(root, ["rev-parse", "--git-common-dir"])).toString("utf8").trim();
  return realpath(resolve(root, raw));
}

async function collectPaths(root) {
  const tracked = (await git(root, ["ls-files", "--cached", "-z"])).toString("utf8").split("\0").filter(Boolean);
  const all = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(Boolean);
  const ignoredRaw = await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks=[]; child.stdout.on("data", c=>chunks.push(c)); child.on("error", reject); child.on("close", () => resolvePromise(Buffer.concat(chunks)));
    child.stdin.end(all.join("\0") + (all.length ? "\0" : ""));
  });
  const ignored = new Set(ignoredRaw.toString("utf8").split("\0").filter(Boolean));
  for (const path of tracked) if (ignored.has(path)) throw new Error("Build refused: an ignored tracked file is selected.");
  if (ignored.size) throw new Error("Build refused: ignored files are selected.");
  for (const path of all) if (!safeRelative(path)) throw new Error("Build refused: an unsafe or forbidden path is selected.");
  return all.sort();
}

async function secureRead(root, rel) {
  let current = root;
  const parts = rel.split("/");
  const ancestors = [];
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()) || (i === parts.length - 1 && !info.isFile())) throw new Error("Build refused: links and special files are not allowed.");
    if (i < parts.length - 1) ancestors.push([current, info.dev, info.ino]);
  }
  const before = await lstat(current);
  if (before.size > MAX_ARCHIVE) throw new Error("Build archive exceeds the 128 MiB limit.");
  if (await realpath(current) !== current) throw new Error("Build refused: a selected path resolves through a symlink.");
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Build refused: a selected file changed during archive creation.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size || await realpath(current) !== current) throw new Error("Build refused: a selected file changed during archive creation.");
    for (const [path, dev, ino] of ancestors) { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== dev || info.ino !== ino) throw new Error("Build refused: an ancestor changed during archive creation."); }
    return { bytes, mode: opened.mode & 0o777 };
  } finally { await handle.close(); }
}

function tarHeader(path, size, mode) {
  const b = Buffer.alloc(512);
  const put = (s, start, length) => b.write(String(s), start, length, "utf8");
  const split = path.length > 100 ? path.lastIndexOf("/", 155) : -1;
  const name = split >= 0 ? path.slice(split + 1) : path;
  const prefix = split >= 0 ? path.slice(0, split) : "";
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error("Build refused: path cannot be represented safely in a tar archive.");
  put(name,0,100); put((mode & 0o777).toString(8).padStart(7,"0")+"\0",100,8); put("0000000\0",108,8); put("0000000\0",116,8);
  put(size.toString(8).padStart(11,"0")+"\0",124,12); put(Math.floor(Date.now()/1000).toString(8).padStart(11,"0")+"\0",136,12);
  b.fill(32,148,156); b[156]=48; put("ustar\0",257,6); put("00",263,2); put(prefix,345,155);
  let sum=0; for (const byte of b) sum+=byte;
  put(sum.toString(8).padStart(6,"0")+"\0 ",148,8);
  return b;
}

export async function createBuildArchive(cwd = process.cwd(), pull = []) {
  const root = await realpath(cwd);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("Build cwd must be a git worktree directory.");
  const repoId = hash(await gitCommonDir(root));
  const worktreeId = hash(root);
  for (const path of pull) if (!safeRelative(path)) throw new Error("Pull paths must be safe relative paths.");
  const paths = await collectPaths(root);
  const pieces = []; let bytes = 0;
  for (const path of paths) {
    const file = await secureRead(root, path);
    const header = tarHeader(path, file.bytes.length, file.mode);
    const padded = Buffer.alloc(Math.ceil(file.bytes.length / 512) * 512); file.bytes.copy(padded);
    pieces.push(header, padded); bytes += header.length + padded.length;
    if (bytes + 1024 > MAX_ARCHIVE) throw new Error("Build archive exceeds the 128 MiB limit.");
  }
  pieces.push(Buffer.alloc(1024)); bytes += 1024;
  return { archive: Buffer.concat(pieces, bytes), repoId, worktreeId, root, pull };
}

function parseVersionChannel(root) {
  // Strictly accept only a simple TOML `channel = "..."` line; reject ambiguous TOML.
  return readFile(join(root, "rust-toolchain.toml"), "utf8").then(text => {
    const matches = text.match(/^\s*channel\s*=\s*"([^"]+)"\s*(?:#.*)?$/gm) ?? [];
    if (matches.length !== 1 || text.split(/\r?\n/).some(line => /^\s*channel\s*=/.test(line) && !/^\s*channel\s*=\s*"[^"]+"\s*(?:#.*)?$/.test(line))) throw new Error("Unsupported rust-toolchain.toml; pass --toolchain explicitly.");
    const value = matches[0].match(/"([^"]+)"/)[1];
    if (!/^(?:\d+\.\d+\.\d+|stable)$/.test(value)) throw new Error("Unsupported rust toolchain channel; pass --toolchain explicitly.");
    return value;
  }).catch(error => { if (error.code === "ENOENT") throw new Error("No supported rust-toolchain.toml found; pass --toolchain explicitly."); throw error; });
}

function validateCommand(command, root) {
  if (!command.length || command.some(value => typeof value !== "string")) throw new Error("Build command must contain command arguments.");
  const joined = command.join(" ").toLowerCase();
  if (/\b(xcrun|xcodebuild|swift)\b/.test(joined) || (/\bcargo\b/.test(joined) && /\btauri\b/.test(joined) && /\bbuild\b/.test(joined)) || /(?:aarch64|x86_64)-apple-(?:darwin|ios)/.test(joined)) throw new Error("Apple toolchains and targets require a local or GitHub macOS build.");
}

export async function runBuild({ cwd = process.cwd(), command, pull = [], toolchain, config, spawnImpl = spawn, outputLimit = Infinity, stdout = process.stdout, stderr = process.stderr, captureOutput = false }) {
  validateCommand(command ?? [], cwd);
  const build = config ?? await loadBuildConfig();
  if (typeof build.sshTarget !== "string" || !HOST.test(build.sshTarget)) throw new Error("Unsafe m5 build SSH target.");
  const prepared = await createBuildArchive(cwd, pull);
  const selectedToolchain = toolchain ?? await parseVersionChannel(prepared.root);
  if (!/^(?:\d+\.\d+\.\d+|stable)$/.test(selectedToolchain)) throw new Error("--toolchain must be a numeric version or stable.");
  const request = { version: 1, repo_id: prepared.repoId, worktree_id: prepared.worktreeId, command, toolchain: selectedToolchain, pull, archive_bytes: prepared.archive.length };
  const requestLine = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(requestLine, "utf8") > 8192) throw new Error("Build worker request header exceeds the 8192-byte limit.");
  if (request.archive_bytes > MAX_ARCHIVE) throw new Error("Build archive exceeds the 128 MiB limit.");
  const child = spawnImpl("ssh", ["-o", "BatchMode=yes", "-o", "SendEnv=", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-T", build.sshTarget, "m5-build-worker"], { stdio: ["pipe", "pipe", "pipe"] });
  let lineBuffer=Buffer.alloc(0); let totalOut=0,totalErr=0,pullTotal=0; let remoteExit; let protocolError; let truncatedOut=false,truncatedErr=false; const pulled=new Map(); const stdoutParts=[]; const stderrParts=[]; const artifactSizes=new Map();
  child.stdout.on("data", chunk => {
    lineBuffer=Buffer.concat([lineBuffer,chunk]);
    if (lineBuffer.length > MAX_LINE && !lineBuffer.includes(10)) { protocolError=new Error("Malformed build worker protocol."); child.kill(); return; }
    let nl; while ((nl=lineBuffer.indexOf(10))>=0) { if (nl > MAX_LINE) { protocolError=new Error("Malformed build worker protocol."); child.kill(); return; } const line=lineBuffer.subarray(0,nl); lineBuffer=lineBuffer.subarray(nl+1); try {
      const msg=JSON.parse(line.toString("utf8"));
      if (remoteExit !== undefined) throw new Error("Duplicate or trailing build worker message.");
      if (msg.type === "stdout" || msg.type === "stderr") {
        const data=Buffer.from(msg.data,"base64"); if (data.toString("base64") !== msg.data) throw new Error("Invalid build worker data.");
        const isOut=msg.type === "stdout"; const room=Math.max(0,outputLimit-(isOut?totalOut:totalErr)); const emitted=data.subarray(0,room);
        if (emitted.length) { (isOut?stdout:stderr).write(emitted); if (captureOutput) (isOut?stdoutParts:stderrParts).push(emitted); }
        if (isOut) { totalOut+=emitted.length; if(emitted.length<data.length)truncatedOut=true; } else {totalErr+=emitted.length;if(emitted.length<data.length)truncatedErr=true;}
      } else if (msg.type === "artifact") {
        const data=Buffer.from(msg.data,"base64"); const fileSize=(artifactSizes.get(msg.path)??0)+data.length; if(!safeRelative(msg.path)||!pull.includes(msg.path)||data.toString("base64")!==msg.data||fileSize>MAX_PULL_FILE||(pullTotal+data.length)>MAX_PULL_TOTAL) throw new Error("Invalid build artifact.");
        artifactSizes.set(msg.path,fileSize); pullTotal+=data.length; pulled.set(msg.path,[...(pulled.get(msg.path)??[]),data]);
      } else if (msg.type === "exit" && Number.isInteger(msg.code)&&msg.code>=0&&msg.code<=255) remoteExit=msg.code;
      else if (msg.type === "error" && msg.code===125 && typeof msg.message==="string") { protocolError=new Error("Build worker infrastructure failure."); }
      else throw new Error("Malformed build worker protocol.");
    } catch(error) { protocolError=error; child.kill(); } }
  });
  child.stdin.write(requestLine); child.stdin.write(prepared.archive); child.stdin.end();
  const sshResult=await new Promise((resolvePromise,reject)=>{child.on("error",reject); child.on("close",code=>resolvePromise(code??125));});
  if(lineBuffer.length || protocolError || remoteExit===undefined || sshResult!==remoteExit) throw protocolError ?? new Error("Build worker protocol failed or ended without a matching exit record.");
  if(pulled.size) await writePulledArtifacts(prepared.root,[...pulled].map(([path,chunks])=>[path,Buffer.concat(chunks)]));
  return { exit_code: remoteExit, truncated: { stdout: truncatedOut, stderr: truncatedErr }, ...(captureOutput ? { stdout: Buffer.concat(stdoutParts).toString("utf8"), stderr: Buffer.concat(stderrParts).toString("utf8") } : {}) };
}

async function writePulledArtifacts(root, artifacts) {
  for (const [rel,data] of artifacts) {
    const target=resolve(root,rel); if(!target.startsWith(root+sep)) throw new Error("Unsafe pulled artifact path.");
    const parts=rel.split("/"); let parent=root;
    for(const part of parts.slice(0,-1)){parent=join(parent,part); try {const st=await lstat(parent); if(st.isSymbolicLink()||!st.isDirectory())throw new Error("Unsafe artifact destination.");}catch(error){if(error.code!=="ENOENT")throw error; await import("node:fs/promises").then(fs=>fs.mkdir(parent));}}
    try {const st=await lstat(target); if(st.isSymbolicLink()||!st.isFile())throw new Error("Refusing to overwrite an unsafe artifact destination.");}catch(error){if(error.code!=="ENOENT")throw error;}
    let exists = true;
    try { await lstat(target); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
    const flags = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (exists ? constants.O_TRUNC : constants.O_EXCL);
    const handle = await open(target, flags, 0o600);
    try { await handle.writeFile(data); } finally { await handle.close(); }
  }
}

export function parseBuildArgs(args) {
  const pull=[]; let toolchain; let i=0;
  while(i<args.length && args[i]!=="--") { const arg=args[i++]; if(arg==="--pull"){if(!args[i])throw new Error("--pull requires a relative path.");pull.push(args[i++]);} else if(arg==="--toolchain"){if(!args[i])throw new Error("--toolchain requires a version or stable.");toolchain=args[i++];} else throw new Error(`Unknown build option: ${arg}`); }
  if(args[i]!=="--"||i===args.length-1)throw new Error("Usage: m5 build [--pull relative/path] [--toolchain version] -- command args");
  return {pull,toolchain,command:args.slice(i+1)};
}
