import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(repoRoot, "client");
const expectedFiles = [
  "LICENSE",
  "README.md",
  "hs.mjs",
  "m5-client.mjs",
  "m5-provision.mjs",
  "m5-stdio-bridge.mjs",
  "m5.mjs",
  "package.json",
];
const expectedVersion = "1.3.4";

function fail(message) {
  throw new Error(`client package release gate: ${message}`);
}

function assertEqual(actual, expected, description) {
  if (actual !== expected) fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const manifest = JSON.parse(readFileSync(join(clientDir, "package.json"), "utf8"));
assertEqual(manifest.name, "gille-inference", "package name");
assertEqual(manifest.version, expectedVersion, "package version");
assertEqual(manifest.type, "module", "module type");
assertEqual(manifest.engines?.node, ">=18", "Node engine");
assertEqual(manifest.publishConfig?.access, "public", "publish access");
assertEqual(manifest.bin?.hs, "hs.mjs", "hs bin");
assertEqual(manifest.bin?.m5, "m5.mjs", "m5 bin");
assertEqual(
  readFileSync(join(clientDir, "LICENSE"), "utf8"),
  readFileSync(join(repoRoot, "LICENSE"), "utf8"),
  "packaged license text",
);
const readme = readFileSync(join(clientDir, "README.md"), "utf8");
if (!readme.includes('npx --package gille-inference hs ask "What is the capital of France?"')) {
  fail("README zero-install example must select the hs binary explicitly");
}
if (readme.includes("npx gille-inference")) {
  fail("README must not use npm exec's ambiguous package-name command form");
}

const cache = mkdtempSync(join(tmpdir(), "gille-inference-client-pack-"));
try {
  const npmHome = join(cache, "npm-home");
  const npmGlobalConfig = join(cache, "global-npmrc");
  const npmUserConfig = join(cache, "npmrc");
  mkdirSync(npmHome);
  writeFileSync(npmGlobalConfig, "");
  writeFileSync(npmUserConfig, "");
  // Keep publish normalization offline and prevent host npm configuration or credentials participating.
  const isolatedNpmEnv = {
    HOME: npmHome,
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    npm_config_cache: join(cache, "npm-cache"),
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_offline: "true",
    npm_config_registry: "http://127.0.0.1:9",
    npm_config_userconfig: npmUserConfig,
  };
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "./client"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: isolatedNpmEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const packs = JSON.parse(output);
  if (!Array.isArray(packs) || packs.length !== 1) fail("npm pack did not return exactly one package");
  const pack = packs[0];
  assertEqual(pack.name, manifest.name, "packed name");
  assertEqual(pack.version, expectedVersion, "packed version");
  const files = pack.files ?? [];
  const paths = files.map((file) => file.path).sort();
  const expectedPaths = [...expectedFiles].sort();
  if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
    fail(`packed files differ: expected ${expectedPaths.join(", ")}, got ${paths.join(", ")}`);
  }
  for (const binary of ["hs.mjs", "m5.mjs"]) {
    const file = files.find((entry) => entry.path === binary);
    if (!file || (file.mode & 0o111) === 0) fail(`${binary} must be executable in the tarball`);
  }

  const archiveOutput = execFileSync("npm", ["pack", "--json", clientDir], {
    cwd: cache,
    encoding: "utf8",
    env: isolatedNpmEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const archives = JSON.parse(archiveOutput);
  if (!Array.isArray(archives) || archives.length !== 1 || typeof archives[0]?.filename !== "string") {
    fail("npm pack did not produce a local tarball for the zero-install smoke test");
  }
  const help = execFileSync(
    "npm",
    ["exec", "--offline", "--yes", "--package", join(cache, archives[0].filename), "--", "hs", "--help"],
    {
      cwd: cache,
      encoding: "utf8",
      env: isolatedNpmEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!help.includes("hs — Gille Inference CLI")) {
    fail("zero-install hs smoke test did not execute the packaged hs binary");
  }
  const m5Version = execFileSync(
    "npm",
    ["exec", "--offline", "--yes", "--package", join(cache, archives[0].filename), "--", "m5", "--version"],
    {
      cwd: cache,
      encoding: "utf8",
      env: isolatedNpmEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!m5Version.includes(`{"name":"m5","version":"${expectedVersion}"}`)) {
    fail("zero-install m5 smoke test did not execute the packaged m5 binary");
  }

  const publishDir = join(cache, "publish");
  cpSync(clientDir, publishDir, { recursive: true });
  const publish = spawnSync(
    "npm",
    [
      "publish",
      "--dry-run",
      "--offline",
      "--ignore-scripts",
      "--registry",
      "http://127.0.0.1:9",
    ],
    {
      cwd: publishDir,
      encoding: "utf8",
      env: isolatedNpmEnv,
    },
  );
  if (publish.error || publish.status !== 0) {
    fail("offline npm publish dry run did not complete");
  }
  const publishOutput = `${publish.stdout}\n${publish.stderr}`;
  if (/auto-corrected|bin\[(?:hs|m5)\].*(?:invalid|removed)|script name (?:hs|m5)\.mjs was invalid/i.test(publishOutput)) {
    fail("npm publish would remove a declared client binary");
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}

console.log(`client package release gate passed: ${manifest.name}@${manifest.version}`);
