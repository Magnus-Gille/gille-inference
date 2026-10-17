import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "qualify-halogen.py");
const profileHash = "a".repeat(64);
const runnerCommit = "b".repeat(40);

const health = {
  status: "ok",
  version: { api: "0.9.1", engine: "0.9.1", match: true },
  private_detail: "must not appear in gate output",
};
const models = {
  object: "list",
  data: [{ id: "qwen38-flash-next", owned_by: "halogen", private_detail: "redact me" }],
};

function response(content: string | null, finishReason = "stop"): JsonObject {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      prompt: "do not copy prompt data",
      request_id: "high-cardinality-id",
      secret: "must not appear in evidence",
    },
  };
}

const toolCallResponse: JsonObject = {
  id: "chatcmpl-tool",
  choices: [{
    index: 0,
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "counter-call-1",
        type: "function",
        function: { name: "read_counter", arguments: "{}" },
      }],
    },
  }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, secret: "redact me" },
};
const toolResultResponse = response("43");

type Scenario = { health?: JsonObject; models?: JsonObject; chat: JsonObject[] };
type ToolMutation = { toolName?: string; id?: string; argumentsMissing?: boolean; arguments?: string; finishReason?: string; callType?: string };
type IdentityOverride = { health?: JsonObject; models?: JsonObject };
type Call = { path: string; body?: JsonObject };
type DriverResult = { ok: boolean; error?: string; errorType?: string; result?: JsonObject; calls: Call[] };

function runGate(scenario: Scenario): DriverResult {
  const modulePath = JSON.stringify(scriptPath);
  const scenarioJson = JSON.stringify({ health, models, ...scenario });
  const driver = `
import importlib.util
import json

module_path = ${modulePath}
scenario = json.loads(${JSON.stringify(scenarioJson)})
calls = []
spec = importlib.util.spec_from_file_location("halogen_qualification_under_test", module_path)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

def fake_request(path, body=None):
    calls.append({"path": path, "body": body})
    if path == "/health":
        return scenario["health"]
    if path == "/v1/models":
        return scenario["models"]
    if path == "/v1/chat/completions":
        chat_calls = [call for call in calls if call["path"] == path]
        return scenario["chat"][len(chat_calls) - 1]
    raise AssertionError("unexpected request path: " + path)

gate.request = fake_request
try:
    result = gate.run("${profileHash}", "${runnerCommit}")
    envelope = {"ok": True, "result": result, "calls": calls}
except BaseException as error:
    envelope = {"ok": False, "errorType": type(error).__name__, "error": str(error), "calls": calls}
print(json.dumps(envelope, separators=(",", ":")))
`;
  const child = spawnSync("python3", ["-I", "-"], {
    cwd: repoRoot,
    input: driver,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (child.error) throw child.error;
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as DriverResult;
}

function successfulScenario(): Scenario {
  return {
    chat: [response("READY"), response("READY"), response("17"), response("29"), toolCallResponse, toolResultResponse],
  };
}

function resultOf(run: DriverResult): JsonObject {
  expect(run.ok, `${run.errorType}: ${run.error}`).toBe(true);
  return run.result!;
}

describe("qualify-halogen.py compatibility gate", () => {
  it("executes exactly the four synthetic cases and one native tool roundtrip", () => {
    const run = runGate(successfulScenario());
    const result = resultOf(run);
    expect(result).toMatchObject({
      schemaVersion: 1,
      gate: "synthetic-compatibility-only",
      profileSha256: profileHash,
      runnerCommit,
      requestProfile: { temperature: 0, maxTokens: 256, thinking: false },
      pass: true,
    });
    expect((result.rows as JsonObject[]).map((row) => row.case)).toEqual([
      "single", "system-user", "multi-message", "tool-result", "native-tool-roundtrip",
    ]);
    expect(run.calls.map((call) => call.path)).toEqual([
      "/health", "/v1/models", "/v1/chat/completions", "/v1/chat/completions",
      "/v1/chat/completions", "/v1/chat/completions", "/v1/chat/completions", "/v1/chat/completions",
    ]);
    expect(run.calls[6]!.body!.tool_choice).toEqual({ type: "function", function: { name: "read_counter" } });
    expect((run.calls[7]!.body!.messages as JsonObject[]).at(-1)).toEqual({
      role: "tool", tool_call_id: "counter-call-1", name: "read_counter", content: "43",
    });
  });

  it.each([
    ["incorrect", response("NOT READY")],
    ["empty", response("")],
    ["length", response("REA", "length")],
  ])("fails closed on %s synthetic output", (_label, badResponse) => {
    const scenario = successfulScenario();
    scenario.chat[0] = badResponse;
    const run = runGate(scenario);
    const result = resultOf(run);
    expect(result.pass).toBe(false);
    expect(result.rows).toHaveLength(4);
    expect(result.rows![0]).toMatchObject({ case: "single", pass: false, errorClass: "incorrect-or-incomplete" });
  });

  it.each<[string, ToolMutation]>([
    ["missing tool call", {}],
    ["wrong tool name", { toolName: "write_counter" }],
    ["missing tool call id", { id: "" }],
    ["missing tool arguments", { argumentsMissing: true }],
    ["wrong tool arguments", { arguments: '{"unexpected":1}' }],
    ["malformed tool arguments", { arguments: "not-json" }],
    ["wrong finish reason", { finishReason: "stop" }],
    ["wrong tool type", { callType: "custom" }],
  ])("fails closed on %s", (_label, mutation) => {
    const scenario = successfulScenario();
    const call = structuredClone(toolCallResponse) as JsonObject;
    const message = ((call.choices as JsonObject[])[0]!.message as JsonObject);
    if (Object.keys(mutation).length === 0) {
      delete message.tool_calls;
    } else {
      const tool = (message.tool_calls as JsonObject[])[0]!;
      if ("finishReason" in mutation) ((call.choices as JsonObject[])[0]!.finish_reason) = mutation.finishReason;
      if ("callType" in mutation) tool.type = mutation.callType;
      if ("toolName" in mutation) ((tool.function as JsonObject).name) = mutation.toolName;
      if ("id" in mutation) tool.id = mutation.id;
      if (mutation.argumentsMissing) delete (tool.function as JsonObject).arguments;
      else if ("arguments" in mutation) (tool.function as JsonObject).arguments = mutation.arguments;
    }
    scenario.chat[4] = call;
    const run = runGate(scenario);
    const result = resultOf(run);
    expect(result.pass).toBe(false);
    expect(result.rows).toHaveLength(5);
    expect(result.rows![4]).toMatchObject({ case: "native-tool-roundtrip", pass: false });
    expect(run.calls).toHaveLength(7);
  });

  it.each<[string, IdentityOverride, RegExp]>([
    ["wrong runtime version", { health: { status: "ok", version: { api: "0.9.0", engine: "0.9.1", match: false } } }, /runtime identity mismatch/],
    ["wrong model identity", { models: { object: "list", data: [{ id: "different-model" }] } }, /model identity mismatch/],
  ])("rejects %s before any chat request", (_label, override, expected) => {
    const run = runGate({ ...successfulScenario(), ...override });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(expected);
    expect(run.calls.map((call) => call.path)).toEqual(override.health ? ["/health"] : ["/health", "/v1/models"]);
  });

  it("keeps usage evidence sanitized to non-negative integer counters", () => {
    const result = resultOf(runGate(successfulScenario()));
    const rows = result.rows as JsonObject[];
    expect(rows.slice(0, 4).map((row) => row.usage)).toEqual([
      { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    ]);
    expect(JSON.stringify(result)).not.toContain("must not appear in evidence");
    expect(JSON.stringify(result)).not.toContain("must not copy prompt data");
    expect(JSON.stringify(result)).not.toContain("must not appear in gate output");
  });

  it("labels the output as an explicit synthetic-only qualification mode", () => {
    const result = resultOf(runGate(successfulScenario()));
    expect(result.gate).toBe("synthetic-compatibility-only");
    expect(result.requestProfile).toEqual({ temperature: 0, maxTokens: 256, thinking: false });
  });

  it("loads the source as a Python module and never uses network I/O", () => {
    expect(readFileSync(scriptPath, "utf8")).toContain("def run(profile_hash, runner_commit):");
    expect(runGate(successfulScenario()).ok).toBe(true);
  });
});
