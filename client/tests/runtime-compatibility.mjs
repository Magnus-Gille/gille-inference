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
  "backend-failure-contract.d.mts",
  "backend-failure-contract.mjs",
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
const hsBaseUrl = "http://127.0.0.1:1";
const m5GatewayUrl = "https://gateway.fixture.invalid";
const previousHome = process.env.HOME;
const previousFetch = globalThis.fetch;
process.env.HOME = homeDir;
mkdirSync(packageDir);
mkdirSync(join(homeDir, ".config", "hs"), { recursive: true });
for (const file of bundledFiles) cpSync(join(clientDir, file), join(packageDir, file));
writeFileSync(
  join(homeDir, ".config", "hs", "config.json"),
  JSON.stringify({ baseUrl: hsBaseUrl, key: "fixture-key" }),
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
  if (request.url === `${hsBaseUrl}/v1/models`) {
    return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (request.url === `${hsBaseUrl}/v1/chat/completions`) {
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
  assert.equal(requests[0].url, `${hsBaseUrl}/v1/models`);
  assert.equal(requests[0].headers.authorization, "Bearer fixture-key");
  assert.equal(requests[1].url, `${hsBaseUrl}/v1/chat/completions`);
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
  assert.deepEqual(JSON.parse(versionOutput.text()), { name: "m5", version: "1.6.0" });

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

  const m5Events = [];
  const m5Requests = [];
  const modelsFetch = async (url, options = {}) => {
    const request = { url: String(url), ...options };
    m5Requests.push(request);
    m5Events.push("fetch");
    assert.equal(request.url, `${m5GatewayUrl}/mcp`, "m5 must use only the explicit synthetic gateway URL");
    const message = JSON.parse(request.body);
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers.authorization, "Bearer synthetic-m5-token");
    assert.equal(request.headers["user-agent"], "m5-cli/1.6.0");
    assert.ok(request.signal instanceof AbortSignal);
    assert.deepEqual(message, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_models", arguments: {} },
    });
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "- mellum — Fixture model" }] },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "fixture-session",
      },
    });
  };
  const m5ModelsOutput = outputCollector();
  const m5ModelsError = outputCollector();
  const m5ModelExitCode = await m5.main(["--profile", "fixture", "models"], {
    output: m5ModelsOutput.stream,
    error: m5ModelsError.stream,
    configLoader: () => {
      m5Events.push("config");
      return {
        version: 1,
        profiles: { fixture: { publicGatewayUrl: m5GatewayUrl } },
      };
    },
    credentialStore: {
      resolve: async (profile) => {
        m5Events.push("credential");
        assert.equal(profile, "fixture");
        return "synthetic-m5-token";
      },
    },
    fetch: modelsFetch,
  });
  assert.equal(m5ModelExitCode, 0, m5ModelsError.text());
  assert.deepEqual(JSON.parse(m5ModelsOutput.text()), {
    models: [{ id: "mellum", description: "Fixture model" }],
  });
  assert.deepEqual(m5Events, ["config", "credential", "fetch"]);
  assert.equal(m5Requests.length, 1);
});
