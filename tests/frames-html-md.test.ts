import { describe, it, expect } from "vitest";
import {
  wikiHtmlToMarkdown,
  tableToMarkdown,
  htmlToCellText,
  decodeEntities,
} from "../scripts/frames-html-md.js";

describe("decodeEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;x")).toBe("a & b <c> A B  x");
  });
});

describe("htmlToCellText", () => {
  it("strips tags and drops reference sups", () => {
    const html = 'Paris<sup class="reference">[1]</sup>, France';
    expect(htmlToCellText(html)).toBe("Paris, France");
  });

  it("escapes a literal pipe so it can't break a GFM cell", () => {
    expect(htmlToCellText("a | b")).toBe("a \\| b");
  });
});

describe("tableToMarkdown — the numerical-data path (issue: stripped tables)", () => {
  it("converts a header+data wikitable to a GFM table preserving every number", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Year</th><th>Population</th></tr>
        <tr><td>2010</td><td>8,175,133</td></tr>
        <tr><td>2020</td><td>8,804,190</td></tr>
      </table>`;
    const md = tableToMarkdown(html);
    const lines = md.trim().split("\n");
    expect(lines[0]).toBe("| Year | Population |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| 2010 | 8,175,133 |");
    expect(lines[3]).toBe("| 2020 | 8,804,190 |");
    // The numbers that a numerical FRAMES question needs are all present.
    expect(md).toContain("8,804,190");
  });

  it("synthesizes a header when the first row is not all-<th>", () => {
    const html = `<table><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></table>`;
    const md = tableToMarkdown(html);
    const lines = md.trim().split("\n");
    expect(lines[0]).toBe("|  |  |"); // empty synthesized header
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| a | 1 |");
    expect(lines[3]).toBe("| b | 2 |");
  });

  it("pads ragged rows to a uniform column count", () => {
    const html = `<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>2</td></tr></table>`;
    const lines = tableToMarkdown(html).trim().split("\n");
    expect(lines[2]).toBe("| 1 | 2 |  |");
  });
});

describe("wikiHtmlToMarkdown — full article", () => {
  it("preserves an infobox table inline with the prose", () => {
    const html = `
      <h2>Demographics</h2>
      <p>The city has grown steadily.</p>
      <table class="infobox">
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Area</td><td>468.9 sq mi</td></tr>
      </table>
      <p>It is the most populous city.</p>`;
    const md = wikiHtmlToMarkdown(html);
    expect(md).toContain("## Demographics");
    expect(md).toContain("The city has grown steadily.");
    expect(md).toContain("| Metric | Value |");
    expect(md).toContain("| Area | 468.9 sq mi |");
    expect(md).toContain("It is the most populous city.");
  });

  it("drops navbox chrome but keeps a data table", () => {
    const html = `
      <table class="navbox"><tr><th>Nav</th></tr><tr><td>links</td></tr></table>
      <table class="wikitable"><tr><th>K</th><th>V</th></tr><tr><td>gold</td><td>42</td></tr></table>`;
    const md = wikiHtmlToMarkdown(html);
    expect(md).not.toContain("links");
    expect(md).toContain("| gold | 42 |");
  });

  it("handles a nested table without breaking the outer matcher", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Outer</th></tr>
        <tr><td>before <table><tr><td>inner</td></tr></table> after</td></tr>
      </table>
      <p>tail</p>`;
    const md = wikiHtmlToMarkdown(html);
    // The important guarantee: prose AFTER the (nested) table is not swallowed.
    expect(md).toContain("tail");
  });

  it("CRITICAL: a nested table inside a cell does NOT drop surrounding cell content (incl. numbers)", () => {
    // Codex CRITICAL: a non-depth-aware row/cell regex closed the outer cell at the first nested
    // </td>, silently dropping "after 8804190" — exactly the numeric evidence the rebuild must keep.
    const html = `
      <table class="wikitable">
        <tr><th>Label</th><th>Value</th></tr>
        <tr><td>Population</td><td>before <table><tr><td>inner junk</td></tr></table> after 8804190</td></tr>
      </table>`;
    const md = wikiHtmlToMarkdown(html);
    expect(md).toContain("8804190"); // the number AFTER the nested table survives
    const dataRow = md.split("\n").find((l) => l.includes("Population"));
    expect(dataRow).toBeDefined();
    // Still a 2-column row (the nested row did not leak in as extra columns): | a | b | → 3 pipes.
    expect((dataRow!.match(/\|/g) ?? []).length).toBe(3);
  });

  it("ignores a <table> literal inside a <script>/comment and still converts the real table", () => {
    const html = `
      <script>const x = "<table><tr><td>fake</td></tr>";</script>
      <!-- <table>commented</table> -->
      <table class="wikitable"><tr><th>K</th><th>V</th></tr><tr><td>real</td><td>42</td></tr></table>`;
    const md = wikiHtmlToMarkdown(html);
    expect(md).not.toContain("fake");
    expect(md).not.toContain("commented");
    expect(md).toContain("| real | 42 |");
  });

  it("an unbalanced <table> does not abandon a later valid table", () => {
    const html =
      `<div><table class="wikitable"><tr><td>orphan</td></div>` + // no closing </table>
      `<table class="wikitable"><tr><th>K</th></tr><tr><td>kept 7</td></tr></table>`;
    const md = wikiHtmlToMarkdown(html);
    expect(md).toContain("kept 7");
  });

  it("preserves a data table that merely carries a generic 'plainlinks' class", () => {
    const html = `<table class="wikitable plainlinks"><tr><th>K</th><th>V</th></tr><tr><td>gdp</td><td>26900</td></tr></table>`;
    const md = wikiHtmlToMarkdown(html);
    expect(md).toContain("| gdp | 26900 |");
  });
});
