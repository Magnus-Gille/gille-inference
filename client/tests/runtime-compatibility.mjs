import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const clientDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundledFiles = [
  "LICENSE",
  "README.md",
  "hs.mjs",
  "m5-client.mjs",
  "m5-build.mjs",
  "m5-build-files.py",
  "m5-provision.mjs",
  "m5-stdio-bridge.mjs",
  "m5.mjs",
  "package.json",
];
const fixtureRoot = mkdtempSync(join(tmpdir(), "gille-client-runtime-"));
const packageDir = join(fixtureRoot, "package");
const homeDir = join(fixtureRoot, "home");
const previousHome = process.env.HOME;
const previousFetch = globalThis.fetch;
process.env.HOME = homeDir;
mkdirSync(packageDir);
mkdirSync(join(homeDir, ".config", "hs"), { recursive: true });
for (const file of bundledFiles) cpSync(join(clientDir, file), join(packageDir, file));
writeFileSync(
  join(homeDir, ".config", "hs", "config.json"),
  JSON.stringify({ baseUrl: "http://127.0.0.1:1", key: "fixture-key" }),
);

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  globalThis.fetch = previousFetch;
});

function outputCollector() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); return true; } },
    text: () => value,
  };
}

async function captureStdout(run) {
  let value = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    value += String(chunk);
    const callback = args.find((arg) => typeof arg === "function");
    callback?.();
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return value;
}

const hs = await import(pathToFileURL(join(packageDir, "hs.mjs")));
const m5 = await import(pathToFileURL(join(packageDir, "m5.mjs")));

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const request = { url: String(url), ...options };
  requests.push(request);
  if (request.url.endsWith("/v1/models")) {
    return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (request.url.endsWith("/v1/chat/completions")) {
    return new Response(
      'data: {"choices":[{"delta":{"content":"fixture "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  throw new Error("unexpected synthetic request");
};

test("packaged hs and m5 CLIs honor their dependency-free contracts", async () => {
  const helpOutput = await captureStdout(() => hs.main(["--help"]));
  assert.match(helpOutput, /hs — Gille Inference CLI/);
  assert.match(helpOutput, /hs ask/);

  const modelsOutput = await captureStdout(() => hs.main(["models"]));
  assert.equal(modelsOutput.trim(), "fixture-model");
  const askOutput = await captureStdout(() =>
    hs.main(["ask", "-m", "fixture-model", "--system", "fixture system", "fixture prompt"]),
  );
  assert.equal(askOutput.trim(), "fixture answer");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:1/v1/models");
  assert.equal(requests[0].headers.authorization, "Bearer fixture-key");
  assert.equal(requests[1].url, "http://127.0.0.1:1/v1/chat/completions");
  const askPayload = JSON.parse(requests[1].body);
  assert.equal(askPayload.model, "fixture-model");
  assert.equal(askPayload.stream, true);
  assert.deepEqual(askPayload.messages, [
    { role: "system", content: "fixture system" },
    { role: "user", content: "fixture prompt" },
  ]);

  await assert.rejects(
    () => hs.ask({
      prompt: "fixture prompt",
      topP: 2,
      configDir: join(homeDir, ".config", "hs"),
      fetch: globalThis.fetch,
    }),
    /top_p must be a number in \[0, 1\]/,
  );
  assert.equal(requests.length, 2, "invalid hs input must be rejected before making a request");

  const m5Output = outputCollector();
  assert.equal(
    await m5.main(["--help"], {
      output: m5Output.stream,
      configLoader: () => { throw new Error("help must not load config"); },
    }),
    0,
  );
  const helpContract = JSON.parse(m5Output.text());
  assert.equal(helpContract.name, "m5");
  assert.ok(helpContract.usage.some((line) => line.includes("doctor")));
  assert.ok(helpContract.usage.some((line) => line.includes("code")));

  const versionOutput = outputCollector();
  assert.equal(await m5.main(["--version"], { output: versionOutput.stream }), 0);
  assert.deepEqual(JSON.parse(versionOutput.text()), { name: "m5", version: "1.5.3" });

  const invalidM5Output = outputCollector();
  const invalidM5Error = outputCollector();
  assert.equal(
    await m5.main(["--timeout-ms", "999", "ask"], {
      output: invalidM5Output.stream,
      error: invalidM5Error.stream,
      configLoader: () => { throw new Error("invalid input must be rejected before config access"); },
      credentialStore: { get: () => { throw new Error("invalid input must be rejected before credential access"); } },
    }),
    1,
  );
  const m5ErrorContract = JSON.parse(invalidM5Error.text());
  assert.equal(m5ErrorContract.error.code, "invalid_args");
  assert.match(m5ErrorContract.error.message, /from 1000 to 600000/);
  assert.equal(requests.length, 2, "invalid m5 input must be rejected before any gateway request");
});
