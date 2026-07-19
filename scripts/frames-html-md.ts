/**
 * frames-html-md.ts — dependency-free Wikipedia-HTML → Markdown converter.
 *
 * The FRAMES oracle corpus was built from the Wikipedia *Extracts* API
 * (`prop=extracts&explaintext=1`), which silently STRIPS tables and infoboxes
 * (Codex CRITICAL on PR #53). FRAMES numerical questions frequently need data
 * that lives in exactly those tables → the oracle arm couldn't answer them even
 * with "gold sources", confounding the numerical-reasoning diagnosis.
 *
 * This converts `action=parse&prop=text` rendered HTML to Markdown, PRESERVING
 * `<table>` data as GFM tables (and infoboxes as key/value tables). It is a
 * focused transform — not a general HTML→MD engine — so it stays dependency-free
 * and unit-testable. The trust anchor is the per-sample evidence preflight in
 * frames-fetch.ts: it verifies the gold answer is actually present in the
 * rebuilt corpus, catching any extraction gap this converter leaves.
 */

// ─── Entity decoding ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  minus: "−",
  times: "×",
  deg: "°",
  hellip: "…",
  // common typographic
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return m;
        }
      }
      return m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

// ─── Cell / inline text extraction ─────────────────────────────────────────────

/** Strip all tags from an HTML fragment → single-line plain text (for table cells). */
export function htmlToCellText(html: string): string {
  let s = html;
  // Drop citation/reference superscripts and edit links entirely (noise, no data).
  s = s.replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "");
  s = s.replace(/<span\b[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "");
  // <br> → space (cell stays single-line).
  s = s.replace(/<br\s*\/?>/gi, " ");
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Collapse whitespace; escape pipes so cell content can't break the GFM table.
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\|/g, "\\|");
  return s;
}

// ─── Table extraction ──────────────────────────────────────────────────────────

/**
 * Table classes that UNAMBIGUOUSLY identify navigation / maintenance chrome (not article data) —
 * skip them. Deliberately narrow (Codex review): generic presentation classes like `plainlinks` /
 * `metadata` also appear on real data tables, so skipping on those silently drops article data.
 */
const SKIP_TABLE_CLASS = /\b(navbox|vertical-navbox|navbox-|ambox|mbox-small|sistersitebox)\b/i;

interface ExtractedTable {
  start: number;
  end: number;
  markdown: string;
}

/**
 * Scan for TOP-LEVEL <table>…</table> spans (depth-aware, so nested tables don't
 * confuse the matcher) and convert each data table to a GFM markdown table.
 * Returns spans in document order; navbox/metadata tables yield an empty markdown
 * (they are removed, not rendered).
 */
function extractTopLevelTables(html: string): ExtractedTable[] {
  const out: ExtractedTable[] = [];
  const openRe = /<table\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let scanFrom = 0;
  while ((m = openRe.exec(html)) !== null) {
    if (m.index < scanFrom) continue; // inside a table we already consumed
    const tableStart = m.index;
    // Walk forward counting <table>/</table> to find the matching close.
    const depthRe = /<\/?table\b[^>]*>/gi;
    depthRe.lastIndex = tableStart;
    let depth = 0;
    let tableEnd = -1;
    let d: RegExpExecArray | null;
    while ((d = depthRe.exec(html)) !== null) {
      if (d[0][1] === "/") {
        depth--;
        if (depth === 0) {
          tableEnd = d.index + d[0].length;
          break;
        }
      } else {
        depth++;
      }
    }
    if (tableEnd === -1) {
      // Unbalanced / false opener (e.g. a stray "<table" with no close): skip PAST this opener and
      // keep scanning — do not abandon every real table that follows (Codex review).
      scanFrom = tableStart + m[0].length;
      openRe.lastIndex = scanFrom;
      continue;
    }
    const tableHtml = html.slice(tableStart, tableEnd);
    const openTag = m[0];
    const md = SKIP_TABLE_CLASS.test(openTag) ? "" : tableToMarkdown(tableHtml);
    out.push({ start: tableStart, end: tableEnd, markdown: md });
    scanFrom = tableEnd;
    openRe.lastIndex = tableEnd;
  }
  return out;
}

/**
 * Extract the inner-HTML of this table's TOP-LEVEL <tr> rows — depth-aware so a nested table's
 * own <tr>s do not terminate an outer row (Codex CRITICAL: a non-depth-aware regex closed the
 * outer row/cell at the first nested </tr>/</td>, silently dropping cell content — incl. numbers —
 * after a nested table). Nested-table HTML stays INSIDE the cell and is flattened by htmlToCellText.
 */
function topLevelRows(tableHtml: string): string[] {
  const rows: string[] = [];
  const tokenRe = /<(\/?)(table|tr)\b[^>]*>/gi;
  let depth = 0; // <table> nesting depth (outer table's open → depth 1)
  let rowStart = -1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(tableHtml)) !== null) {
    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toLowerCase();
    if (tag === "table") {
      depth += closing ? -1 : 1;
      continue;
    }
    if (depth !== 1) continue; // a <tr> belonging to a NESTED table — ignore
    if (!closing) rowStart = m.index + m[0].length;
    else if (rowStart !== -1) {
      rows.push(tableHtml.slice(rowStart, m.index));
      rowStart = -1;
    }
  }
  return rows;
}

/** Extract this row's TOP-LEVEL cells (depth-aware re: nested tables). Returns {th, html} per cell. */
function topLevelCells(rowHtml: string): { th: boolean; html: string }[] {
  const cells: { th: boolean; html: string }[] = [];
  const tokenRe = /<(\/?)(table|td|th)\b[^>]*>/gi;
  let depth = 0; // nested-<table> depth within the row (0 = this row's own cells)
  let cellStart = -1;
  let cellTh = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(rowHtml)) !== null) {
    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toLowerCase();
    if (tag === "table") {
      depth += closing ? -1 : 1;
      continue;
    }
    if (depth !== 0) continue; // td/th inside a nested table — part of the outer cell, ignore
    if (!closing) {
      if (cellStart === -1) {
        cellStart = m.index + m[0].length;
        cellTh = tag === "th";
      }
    } else if (cellStart !== -1) {
      cells.push({ th: cellTh, html: rowHtml.slice(cellStart, m.index) });
      cellStart = -1;
    }
  }
  return cells;
}

/** Convert one <table>…</table> HTML span to a GFM markdown table (best-effort, depth-aware). */
export function tableToMarkdown(tableHtml: string): string {
  const rows: { cells: string[]; header: boolean }[] = [];
  for (const rowHtml of topLevelRows(tableHtml)) {
    const cellSpans = topLevelCells(rowHtml);
    if (cellSpans.length === 0) continue;
    const cells = cellSpans.map((c) => htmlToCellText(c.html));
    const headerCells = cellSpans.filter((c) => c.th).length;
    // A row is a header row when EVERY cell is a <th>.
    rows.push({ cells, header: headerCells === cells.length });
  }
  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.cells.length));
  if (width === 0) return "";
  const pad = (cells: string[]): string[] => {
    const copy = cells.slice();
    while (copy.length < width) copy.push("");
    return copy;
  };

  const lines: string[] = [];
  // Use the first row as the header if it's a header row; otherwise synthesize an
  // empty header (GFM requires a header + separator).
  let bodyStart = 0;
  let headerCells: string[];
  if (rows[0]!.header) {
    headerCells = pad(rows[0]!.cells);
    bodyStart = 1;
  } else {
    headerCells = new Array(width).fill("");
  }
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`| ${new Array(width).fill("---").join(" | ")} |`);
  for (let i = bodyStart; i < rows.length; i++) {
    lines.push(`| ${pad(rows[i]!.cells).join(" | ")} |`);
  }
  return lines.join("\n");
}

// ─── Block (prose) conversion ──────────────────────────────────────────────────

/** Convert the non-table HTML (headings, paragraphs, lists) to markdown prose. */
function blocksToMarkdown(html: string): string {
  let s = html;
  // Remove noise outright.
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "");
  s = s.replace(/<span\b[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "");
  // Drop figures/images (no alt-data we can use as text reliably).
  s = s.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "");
  s = s.replace(/<img\b[^>]*>/gi, "");

  // Headings.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
    const hashes = "#".repeat(Number(lvl));
    return `\n\n${hashes} ${htmlToCellText(inner)}\n\n`;
  });
  // List items.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${htmlToCellText(inner)}`);
  s = s.replace(/<\/(ul|ol)>/gi, "\n\n");
  // Paragraphs / breaks / block ends → newlines.
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(div|section|tr|h[1-6])>/gi, "\n");
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Normalise whitespace: trim trailing spaces, collapse >2 blank lines.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, (lead) => (lead.length > 0 ? "" : lead)))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Strip <script>/<style>/HTML comments up front so the table scanner (which runs BEFORE prose
 * cleaning) cannot be tripped by a `<table>` literal inside script/style/comment text (Codex
 * review). blocksToMarkdown strips these again — harmless on already-clean input.
 */
function precleanHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

/**
 * Convert Wikipedia `action=parse&prop=text` HTML to Markdown, preserving table /
 * infobox data as GFM tables. Tables are extracted in place so their data appears
 * at the right point in the article flow.
 */
export function wikiHtmlToMarkdown(rawHtml: string): string {
  const html = precleanHtml(rawHtml);
  const tables = extractTopLevelTables(html);
  if (tables.length === 0) return blocksToMarkdown(html);

  // Splice: convert the prose between tables, and drop each table's markdown in place.
  const parts: string[] = [];
  let cursor = 0;
  for (const t of tables) {
    parts.push(blocksToMarkdown(html.slice(cursor, t.start)));
    if (t.markdown) parts.push("\n\n" + t.markdown + "\n\n");
    cursor = t.end;
  }
  parts.push(blocksToMarkdown(html.slice(cursor)));
  return parts
    .filter((p) => p.trim() !== "")
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
