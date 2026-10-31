import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createM5Client, diagnoseProfile, REQUIRED_AGENT_TOOLS } from "../m5-client.mjs";
import { main } from "../m5.mjs";

// Exercise the production defaults, including HOME/config discovery, with only synthetic
// files and an injected transport. No real gateway, credential store or inference is used.
test("Linux CLI, client and doctor select protected profile files by default", {
  skip: process.platform !== "linux",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "m5-linux-default-"));
  const home = join(root, "home");
  const token = "hs_synthetic_default_path_only";
  const gatewayUrl = "https://gateway.fixture.invalid";
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  const requests = [];
  const json = (body) => new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
  const fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith(`${gatewayUrl}/`));
    const path = String(url).slice(gatewayUrl.length);
    requests.push(path);
    if (path === "/healthz") {
      assert.equal(options.headers?.authorization, undefined);
      return json({});
    }
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    if (path === "/portal/me") return json({ tier: "owner", scope: "agent" });
    assert.equal(path, "/mcp");
    const message = JSON.parse(options.body);
    if (message.method === "tools/list") {
      return json({ jsonrpc: "2.0", id: message.id, result: {
        tools: REQUIRED_AGENT_TOOLS.map(name => ({ name })),
      } });
    }
    assert.equal(message.method, "tools/call");
    const name = message.params.name;
    requests.push(name);
    assert.ok(["list_models", "ask"].includes(name));
    return json({ jsonrpc: "2.0", id: message.id, result: { content: [{
      type: "text", text: name === "ask" ? "synthetic answer" : "- fixture — Synthetic model",
    }] } });
  };
  const collect = () => {
    let text = "";
    return { stream: { write(chunk) { text += String(chunk); return true; } }, text: () => text };
  };
  try {
    for (const directory of [home, join(home, ".config"), join(home, ".config/m5"),
      join(home, ".config/m5/credentials")]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const credential = join(home, ".config/m5/credentials/gateway-agent-fixture");
    writeFileSync(credential, token, { mode: 0o600 });
    chmodSync(credential, 0o600);
    writeFileSync(join(home, ".config/m5/config.json"), JSON.stringify({
      version: 1, profiles: { fixture: { publicGatewayUrl: gatewayUrl } },
    }));
    process.env.HOME = home;
    globalThis.fetch = () => assert.fail("all transport must be injected");

    const output = collect();
    const error = collect();
    assert.equal(await main(["--profile", "fixture", "ask"], {
      input: Readable.from([JSON.stringify({ model: "fixture", prompt: "synthetic prompt" })]),
      output: output.stream, error: error.stream, fetch,
    }), 0, error.text());
    assert.equal(JSON.parse(output.text()).text, "synthetic answer");
    assert.equal(requests.filter(value => value === "ask").length, 1);
    assert.ok(!output.text().includes(token));

    const direct = await createM5Client({ gatewayUrl, profile: "fixture", fetch });
    assert.deepEqual((await direct.models()).models.map(model => model.id), ["fixture"]);

    requests.length = 0;
    const result = await diagnoseProfile({
      profile: "fixture", profileConfig: { publicGatewayUrl: gatewayUrl }, fetch,
    });
    assert.equal(result.status, "mcp_reachable");
    assert.equal(result.credential, "present");
    assert.ok(requests.includes("/portal/me"));
    assert.ok(requests.includes("list_models"));
    assert.ok(!requests.includes("ask"), "default doctor must not run inference");

    const doctorOutput = collect();
    assert.equal(await main(["--profile", "fixture", "doctor"], {
      output: doctorOutput.stream, error: error.stream, fetch,
    }), 0, error.text());
    assert.equal(JSON.parse(doctorOutput.text()).credential, "present");

    // An unsafe file fails before any transport, and diagnostics contain no path/token.
    chmodSync(credential, 0o644);
    requests.length = 0;
    const failedOutput = collect();
    assert.equal(await main(["--profile", "fixture", "doctor"], {
      output: failedOutput.stream, error: error.stream, fetch,
    }), 1);
    assert.equal(JSON.parse(failedOutput.text()).status, "credential_unavailable");
    assert.equal(JSON.parse(failedOutput.text()).auth_layer, "profile_file");
    for (const secret of [home, credential, token]) {
      assert.ok(!failedOutput.text().includes(secret));
    }
    assert.deepEqual(requests, []);

    rmSync(credential);
    let bridgeChecked = false;
    assert.equal(await main(["--profile", "fixture", "mcp"], {
      output: output.stream, error: error.stream, fetch,
      bridgeRunner: async ({ bridge }) => {
        const response = JSON.parse(await bridge.handleLine(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "ask", arguments: { model: "fixture", prompt: "synthetic prompt" } },
        })));
        assert.equal(response.error.data.m5_code, "missing_credential");
        assert.match(response.error.message, /^The selected profile has no usable credential\./);
        bridgeChecked = true;
      },
    }), 0, error.text());
    assert.equal(bridgeChecked, true);
    assert.deepEqual(requests, []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
