/** parseProposals / extractJsonArray (research-proposals.ts) + buildProposalsPanel (poster). */
import { describe, it, expect } from "vitest";
import { parseProposals, extractJsonArray } from "../src/homeserver/research-proposals.js";
import { buildProposalsPanel } from "../scripts/post-research-sweep-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";

describe("extractJsonArray", () => {
  it("pulls a balanced array out of prose + code fences", () => {
    const text = 'Here you go:\n```json\n[{"a":1},{"b":[2,3]}]\n```\nDone.';
    expect(extractJsonArray(text)).toBe('[{"a":1},{"b":[2,3]}]');
  });
  it("ignores brackets inside strings", () => {
    expect(extractJsonArray('[{"k":"a]b"}]')).toBe('[{"k":"a]b"}]');
  });
  it("returns null when there is no array", () => {
    expect(extractJsonArray("no json here")).toBeNull();
  });
});

describe("parseProposals", () => {
  it("parses + coerces a typical (messy) model output", () => {
    const out = `Sure! Here are the proposals:
\`\`\`json
[
  {"title":"Speculative decoding","idea":"Use a small draft model","rationale":"2x faster","expectedGain":"speed","effort":"medium","sources":["https://example.com/spec"]},
  {"title":"IQ4_XS quant","idea":"Re-quant the 80B","gain":"both","effort":"S","source":"https://hf.co/x"}
]
\`\`\``;
    const p = parseProposals(out);
    expect(p.length).toBe(2);
    expect(p[0]!.expectedGain).toBe("speed");
    expect(p[0]!.effort).toBe("M");
    expect(p[0]!.sources).toEqual(["https://example.com/spec"]);
    expect(p[1]!.expectedGain).toBe("both"); // from `gain`
    expect(p[1]!.effort).toBe("S");
    expect(p[1]!.sources).toEqual(["https://hf.co/x"]); // from singular `source`
  });
  it("drops malformed items but keeps valid ones", () => {
    const p = parseProposals('[{"title":"ok","idea":"do x"}, {"no_title":true}, {"title":"", "idea":"y"}]');
    expect(p.length).toBe(1);
    expect(p[0]!.title).toBe("ok");
  });
  it("returns [] when there is no JSON array", () => {
    expect(parseProposals("the model refused")).toEqual([]);
  });
  it("drops non-http sources", () => {
    const p = parseProposals('[{"title":"t","idea":"i","sources":["not-a-url","https://ok.com"]}]');
    expect(p[0]!.sources).toEqual(["https://ok.com"]);
  });
});

describe("buildProposalsPanel", () => {
  it("emits a valid table panel", () => {
    const panel = buildProposalsPanel(
      [{ title: "T", idea: "I", rationale: "R", expectedGain: "speed", effort: "M", sources: ["https://s"] }],
      "2026-06-29T00:00:00Z"
    );
    expect(panel.kind).toBe("table");
    expect(PANEL_ID_RE.test(panel.panel)).toBe(true);
    expect(panel.rows[0]).toMatchObject({ proposal: "T", gain: "speed", effort: "M", source: "https://s" });
    expect(panel.label).toContain("2026-06-29");
  });
});
