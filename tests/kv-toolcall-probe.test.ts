import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

/**
 * Unit tests for the response evaluator in scripts/kv-toolcall-probe.py.
 *
 * Two defects found by cross-model review of PR #223 are pinned here:
 *  - `argsValidJson` was set for ANY decoded dict, without checking the emitted function name or
 *    the declared schema, so a call to the wrong tool with `{}` scored as valid and inflated the
 *    reported tool-call fidelity relative to its documented meaning;
 *  - `evaluate()` caught only KeyError/IndexError, so a malformed response shape raised
 *    TypeError/AttributeError and aborted the entire probe run instead of recording one failed trial.
 */

const PROBE = resolve(__dirname, "..", "scripts", "kv-toolcall-probe.py");

function evaluate(body: unknown, sector = 471, code = "XJ-2291"): Record<string, unknown> {
  const py = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("p", ${JSON.stringify(PROBE)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "body = json.loads(sys.stdin.read())",
    `print(json.dumps(m.evaluate(body, ${sector}, ${JSON.stringify(code)})))`,
  ].join("\n");
  const out = execFileSync("python3", ["-c", py], {
    input: JSON.stringify(body),
    encoding: "utf8",
  });
  return JSON.parse(out) as Record<string, unknown>;
}

function goodCall(args: unknown) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "report_activation_code", arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

describe("kv-toolcall-probe evaluate(): schema conformance", () => {
  it("scores a correct, schema-valid call as correct", () => {
    const r = evaluate(goodCall({ sector: 471, code: "XJ-2291" }));
    expect(r.toolCallEmitted).toBe(true);
    expect(r.toolNameCorrect).toBe(true);
    expect(r.argsValidJson).toBe(true);
    expect(r.argsSchemaValid).toBe(true);
    expect(r.valueCorrect).toBe(true);
    expect(r.sectorCorrect).toBe(true);
  });

  it("does NOT count a call to the wrong tool as schema-valid", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "wrong_tool", arguments: "{}" } }] } },
      ],
    };
    const r = evaluate(body);
    expect(r.toolCallEmitted).toBe(true);
    expect(r.toolNameCorrect).toBe(false);
    expect(r.argsSchemaValid).toBe(false);
    expect(r.valueCorrect).toBe(false);
  });

  it("does NOT count missing required fields as schema-valid", () => {
    const r = evaluate(goodCall({ sector: 471 }));
    expect(r.argsValidJson).toBe(true);
    expect(r.argsSchemaValid).toBe(false);
    expect(r.valueCorrect).toBe(false);
  });

  it("does NOT count wrong argument types as schema-valid", () => {
    const r = evaluate(goodCall({ sector: "471", code: 2291 }));
    expect(r.argsSchemaValid).toBe(false);
    expect(r.valueCorrect).toBe(false);
  });

  it("rejects a boolean sector (bool is an int subclass in Python)", () => {
    const r = evaluate(goodCall({ sector: true, code: "XJ-2291" }));
    expect(r.argsSchemaValid).toBe(false);
  });

  it("marks a wrong needle incorrect even when the schema is satisfied", () => {
    const r = evaluate(goodCall({ sector: 471, code: "ZZ-0000" }));
    expect(r.argsSchemaValid).toBe(true);
    expect(r.valueCorrect).toBe(false);
  });

  it("treats unparseable arguments as invalid JSON rather than raising", () => {
    const body = {
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: "report_activation_code", arguments: "{not json" } }],
          },
        },
      ],
    };
    const r = evaluate(body);
    expect(r.argsValidJson).toBe(false);
    expect(r.valueCorrect).toBe(false);
  });
});

describe("kv-toolcall-probe evaluate(): totality on malformed responses", () => {
  const malformed: Array<[string, unknown]> = [
    ["empty object", {}],
    ["null choices", { choices: null }],
    ["empty choices", { choices: [] }],
    ["non-object choice", { choices: ["nope"] }],
    ["non-object message", { choices: [{ message: "nope" }] }],
    ["null tool_calls with content", { choices: [{ message: { content: "no call made" } }] }],
    ["non-object tool call", { choices: [{ message: { tool_calls: ["nope"] } }] }],
    ["non-object function", { choices: [{ message: { tool_calls: [{ function: 3 }] } }] }],
    [
      "non-string arguments",
      { choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: 7 } }] } }] },
    ],
  ];

  for (const [label, body] of malformed) {
    it(`returns a failed row rather than raising: ${label}`, () => {
      const r = evaluate(body);
      expect(r.valueCorrect).toBe(false);
      expect(r).toHaveProperty("toolCallEmitted");
      expect(r).toHaveProperty("argsSchemaValid");
    });
  }
});
