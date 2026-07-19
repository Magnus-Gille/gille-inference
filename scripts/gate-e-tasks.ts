/**
 * gate-e-tasks.ts — the 20 orchestration tasks (ORCH_TASKS) for the Gate E bake-off.
 *
 * 4 families × 5 tasks. A task qualifies only if the BRAIN must plan + route + integrate
 * (correctness depends on decisions *between* leaf calls, not any single leaf output):
 *
 *   D1 — Deep research (reuse the frozen FRAMES oracle corpus; multi-hop + the known-hard
 *        numeric cases, so E1's relative-to-A0 bar is a fair stressor).
 *   D2 — Feature task: plan a primitive→export→test decomposition (scored by plan_coverage);
 *        the single produced module is gated deterministically by tsGate (tsc + vitest green).
 *   D3 — Pipeline-of-tools: extract→aggregate→classify→summarize; exact top-3 set is the
 *        deterministic anchor (golds computed by scratchpad/gen-gate-e-data.py, never by hand).
 *   D4 — Ambiguous/recovery: an embedded unviable `sql` leaf (JOIN+GROUP BY+HAVING — the
 *        characterized hard gap) that must escalate *lazily* (that leaf only), then integrate.
 *
 * Gold answers + decompositions live here; the D3/D4 datasets + computed golds live in the
 * auto-generated scripts/gate-e-data.ts. See docs/gate-de-evaluation-plan.md §"Gate E".
 */

import type { OrchTask } from "./gate-e-types.js";
import { D3D4_DATA, type D3Data, type D4Data } from "./gate-e-data.js";

const d3 = (id: string): D3Data => D3D4_DATA[id] as D3Data;
const d4 = (id: string): D4Data => D3D4_DATA[id] as D4Data;

// ─────────────────────────────────────────────────────────────────────────────
// D1 — Deep research (frozen FRAMES corpus). corpusRef → data/frames/corpus/<idx>.json
//   gold answers from data/frames/sample.jsonl. gapLeaves=[] (E4 is D4-only).
// ─────────────────────────────────────────────────────────────────────────────

const D1_TASKS: OrchTask[] = [
  {
    id: "D1-01",
    family: "D1",
    title: "Future wife's name (15th first lady's mother)",
    prompt:
      "If my future wife has the same first name as the 15th first lady of the United States' mother, " +
      "and her last name is the same as the second assassinated president's mother's maiden name, " +
      "what is my future wife's name?",
    requiredSubtasks: [
      "identify the 15th first lady of the United States",
      "find that first lady's mother's first name",
      "identify the second assassinated US president",
      "find that president's mother's maiden name",
      "combine first name and maiden surname into the full name",
    ],
    gapLeaves: [],
    scorer: { kind: "frames", goldAnswer: "Jane Ballou" },
    corpusRef: "data/frames/corpus/0.json",
  },
  {
    id: "D1-02",
    family: "D1",
    title: "FIFA World Cup holders when US last hosted",
    prompt:
      "As of August 1, 2024, which country were holders of the FIFA World Cup the last time the United States " +
      "hosted the men's FIFA World Cup?",
    requiredSubtasks: [
      "find the last year the United States hosted the men's FIFA World Cup",
      "identify which country held the FIFA World Cup title that year",
      "report that country",
    ],
    gapLeaves: [],
    scorer: { kind: "frames", goldAnswer: "France" },
    corpusRef: "data/frames/corpus/3.json",
  },
  {
    id: "D1-03",
    family: "D1",
    title: "Vocalist of first band in a chart range",
    prompt:
      "What is the name of the vocalist from the first band to make it into the top 200 under the record label " +
      "that released the soundtrack album described, given the constraints in the question?",
    requiredSubtasks: [
      "identify the relevant record label",
      "find the first band on that label to chart in the top 200",
      "identify that band's vocalist",
    ],
    gapLeaves: [],
    scorer: { kind: "frames", goldAnswer: "Jens Kidman" },
    corpusRef: "data/frames/corpus/4.json",
  },
  {
    id: "D1-04",
    family: "D1",
    title: "Punxsutawney Phil canonical-age arithmetic (numeric)",
    prompt:
      "How many years earlier would Punxsutawney Phil have to be canonically alive to have made a specific " +
      "prediction, given the canonical age claim and the year in the question?",
    requiredSubtasks: [
      "find Punxsutawney Phil's canonical age / birth year claim",
      "identify the target prediction year",
      "compute the difference in years",
    ],
    gapLeaves: [],
    scorer: { kind: "frames", goldAnswer: "87" },
    corpusRef: "data/frames/corpus/2.json",
  },
  {
    id: "D1-05",
    family: "D1",
    title: "2000 census population of a birth city (numeric)",
    prompt:
      "According to the 2000 United States census, what was the 2000 population of the birth city referenced " +
      "in the question?",
    requiredSubtasks: [
      "identify the person and their birth city",
      "look up that city's 2000 US census population",
      "report the population figure",
    ],
    gapLeaves: [],
    scorer: { kind: "frames", goldAnswer: "506000" },
    corpusRef: "data/frames/corpus/5.json",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// D2 — Feature task. The brain plans a primitive→export→test decomposition (scored by
//   plan_coverage), and the produced code is gated deterministically by tsGate (candidate
//   code + harness concatenated, tsc+tsx run locally). The deliverable is a single
//   integrated module — the decomposition is the brain's job, tsGate is the answer anchor.
// ─────────────────────────────────────────────────────────────────────────────

const D2_TASKS: OrchTask[] = [
  {
    id: "D2-01",
    family: "D2",
    title: "chunkBy(arr, size) array splitter",
    prompt:
      "Implement and export a TypeScript function `chunkBy<T>(arr: T[], size: number): T[][]` that splits `arr` " +
      "into consecutive chunks of length `size` (the final chunk may be shorter). It must throw a RangeError if " +
      "`size` is less than 1. Plan it as: add the primitive to utils.ts, export it from index.ts, and add a " +
      "vitest in utils.test.ts covering the basic split, the empty-array case, and the size<1 error. " +
      "Return only the TypeScript code in a single ```ts block.",
    requiredSubtasks: [
      "implement the chunkBy primitive in utils.ts",
      "export chunkBy from index.ts",
      "add a vitest in utils.test.ts covering basic, empty, and size<1 error",
    ],
    gapLeaves: [],
    scorer: {
      kind: "tsGate",
      harness: [
        "const _r = chunkBy([1, 2, 3, 4, 5], 2);",
        'if (JSON.stringify(_r) !== JSON.stringify([[1,2],[3,4],[5]])) throw new Error("chunkBy basic split wrong: " + JSON.stringify(_r));',
        'if (JSON.stringify(chunkBy<number>([], 3)) !== "[]") throw new Error("chunkBy empty should be []");',
        "let _threw = false; try { chunkBy([1, 2], 0); } catch { _threw = true; }",
        'if (!_threw) throw new Error("chunkBy must throw when size < 1");',
      ].join("\n"),
    },
  },
  {
    id: "D2-02",
    family: "D2",
    title: "slugify(s) URL slug",
    prompt:
      "Implement and export `slugify(s: string): string` that lowercases the input, replaces every run of " +
      "non-alphanumeric ASCII characters with a single hyphen, and trims leading/trailing hyphens. " +
      "Plan it as primitive (utils.ts) → export (index.ts) → vitest (utils.test.ts). " +
      "Return only the TypeScript code in a single ```ts block.",
    requiredSubtasks: [
      "implement the slugify primitive in utils.ts",
      "export slugify from index.ts",
      "add a vitest in utils.test.ts for casing, separators, and trimming",
    ],
    gapLeaves: [],
    scorer: {
      kind: "tsGate",
      harness: [
        'if (slugify("Hello, World!") !== "hello-world") throw new Error("slugify basic: " + slugify("Hello, World!"));',
        'if (slugify("  A/B   Testing 101 ") !== "a-b-testing-101") throw new Error("slugify separators: " + slugify("  A/B   Testing 101 "));',
        'if (slugify("--Leading--and--Trailing--") !== "leading-and-trailing") throw new Error("slugify trim: " + slugify("--Leading--and--Trailing--"));',
      ].join("\n"),
    },
  },
  {
    id: "D2-03",
    family: "D2",
    title: "parseDuration('1h30m') → seconds",
    prompt:
      "Implement and export `parseDuration(s: string): number` that parses a compact duration like " +
      '"1h30m", "45s", or "2h" into a total number of seconds (h=3600, m=60, s=1). It must throw on an empty ' +
      "or unparseable string. Plan it as primitive → export → vitest. " +
      "Return only the TypeScript code in a single ```ts block.",
    requiredSubtasks: [
      "implement the parseDuration primitive in utils.ts",
      "export parseDuration from index.ts",
      "add a vitest in utils.test.ts covering combined units and the error case",
    ],
    gapLeaves: [],
    scorer: {
      kind: "tsGate",
      harness: [
        'if (parseDuration("1h30m") !== 5400) throw new Error("parseDuration 1h30m: " + parseDuration("1h30m"));',
        'if (parseDuration("45s") !== 45) throw new Error("parseDuration 45s");',
        'if (parseDuration("2h") !== 7200) throw new Error("parseDuration 2h");',
        "let _t = false; try { parseDuration(\"\"); } catch { _t = true; }",
        'if (!_t) throw new Error("parseDuration must throw on empty");',
      ].join("\n"),
    },
  },
  {
    id: "D2-04",
    family: "D2",
    title: "topK(items, k, scoreFn) selection",
    prompt:
      "Implement and export `topK<T>(items: T[], k: number, scoreFn: (x: T) => number): T[]` returning the `k` " +
      "highest-scoring items in descending score order (ties keep input order). If `k >= items.length`, return " +
      "all items sorted by score. Plan it as primitive → export → vitest. " +
      "Return only the TypeScript code in a single ```ts block.",
    requiredSubtasks: [
      "implement the topK primitive in utils.ts",
      "export topK from index.ts",
      "add a vitest in utils.test.ts covering ordering and k>=length",
    ],
    gapLeaves: [],
    scorer: {
      kind: "tsGate",
      harness: [
        "const _items = [{v:1},{v:5},{v:3},{v:5}];",
        "const _r = topK(_items, 2, (x: {v:number}) => x.v);",
        'if (JSON.stringify(_r) !== JSON.stringify([{v:5},{v:5}])) throw new Error("topK order: " + JSON.stringify(_r));',
        "const _all = topK(_items, 10, (x: {v:number}) => x.v);",
        'if (_all.length !== 4 || _all[0].v !== 5 || _all[3].v !== 1) throw new Error("topK k>=length: " + JSON.stringify(_all));',
      ].join("\n"),
    },
  },
  {
    id: "D2-05",
    family: "D2",
    title: "deepGet(obj, path) safe nested access",
    prompt:
      "Implement and export `deepGet(obj: unknown, path: string): unknown` that reads a dotted path like " +
      '"a.b.c" from a nested object, returning `undefined` if any segment is missing or a non-object is ' +
      "traversed (never throwing). Plan it as primitive → export → vitest. " +
      "Return only the TypeScript code in a single ```ts block.",
    requiredSubtasks: [
      "implement the deepGet primitive in utils.ts",
      "export deepGet from index.ts",
      "add a vitest in utils.test.ts covering a hit and a missing path",
    ],
    gapLeaves: [],
    scorer: {
      kind: "tsGate",
      harness: [
        "const _o = { a: { b: { c: 7 } } };",
        'if (deepGet(_o, "a.b.c") !== 7) throw new Error("deepGet hit");',
        'if (deepGet(_o, "a.x.c") !== undefined) throw new Error("deepGet miss should be undefined");',
        'if (deepGet(_o, "a.b.c.d") !== undefined) throw new Error("deepGet over-traverse should be undefined");',
      ].join("\n"),
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// D3 — Pipeline-of-tools. Brain plans extract→aggregate→classify→summarize over the
//   frozen dataset; answer_pass = exact top-3 set present in the final answer.
//   stageChecklist = declared stages that must each appear (no stage skipped).
// ─────────────────────────────────────────────────────────────────────────────

const D3_STAGES = ["extract", "aggregate", "classify", "summarize"];

const D3_TASKS: OrchTask[] = [
  {
    id: "D3-01",
    family: "D3",
    title: "Top-3 IPs by 5xx count from an access log",
    prompt:
      "Given the access log below, find the top-3 client IPs by count of 5xx responses, classify each as " +
      "likely bot or human, and draft a one-paragraph incident summary. List the top-3 IPs explicitly.\n\n" +
      d3("D3-01").inputData,
    requiredSubtasks: [
      "extract 5xx response lines from the log",
      "aggregate 5xx counts per client IP",
      "classify each top IP as bot or human",
      "summarize the incident",
    ],
    gapLeaves: [],
    scorer: { kind: "pipeline", goldTop3: d3("D3-01").goldTop3, stageChecklist: D3_STAGES },
    inputData: d3("D3-01").inputData,
  },
  {
    id: "D3-02",
    family: "D3",
    title: "Top-3 merchants by total refunded amount",
    prompt:
      "From the transactions CSV below, find the top-3 merchants by total refunded amount (rows with " +
      "type=refund only), classify each refund level as high/medium/low, and write a short summary. " +
      "List the top-3 merchants explicitly.\n\n" +
      d3("D3-02").inputData,
    requiredSubtasks: [
      "extract refund rows from the CSV",
      "aggregate refunded amount per merchant",
      "classify each merchant's refund level",
      "summarize the refund findings",
    ],
    gapLeaves: [],
    scorer: { kind: "pipeline", goldTop3: d3("D3-02").goldTop3, stageChecklist: D3_STAGES },
    inputData: d3("D3-02").inputData,
  },
  {
    id: "D3-03",
    family: "D3",
    title: "Top-3 endpoints by error count",
    prompt:
      "From the API log below, find the top-3 endpoints by count of error responses (status >= 400), " +
      "classify each as client-side or server-side dominant, and summarize. List the top-3 endpoints " +
      "explicitly.\n\n" +
      d3("D3-03").inputData,
    requiredSubtasks: [
      "extract error (status>=400) lines",
      "aggregate error counts per endpoint",
      "classify each endpoint's error type",
      "summarize the error hotspots",
    ],
    gapLeaves: [],
    scorer: { kind: "pipeline", goldTop3: d3("D3-03").goldTop3, stageChecklist: D3_STAGES },
    inputData: d3("D3-03").inputData,
  },
  {
    id: "D3-04",
    family: "D3",
    title: "Top-3 users by message count",
    prompt:
      "From the chat export below, find the top-3 users by number of messages, classify each as active or " +
      "very-active, and write a one-line summary. List the top-3 users explicitly.\n\n" +
      d3("D3-04").inputData,
    requiredSubtasks: [
      "extract user from each chat line",
      "aggregate message counts per user",
      "classify each top user's activity level",
      "summarize participation",
    ],
    gapLeaves: [],
    scorer: { kind: "pipeline", goldTop3: d3("D3-04").goldTop3, stageChecklist: D3_STAGES },
    inputData: d3("D3-04").inputData,
  },
  {
    id: "D3-05",
    family: "D3",
    title: "Top-3 most-depended-on packages",
    prompt:
      "From the dependency manifest below (a JSON map of module → its direct dependencies), find the top-3 " +
      "most-depended-on packages by number of modules that list them, classify each as core or peripheral, " +
      "and summarize. List the top-3 packages explicitly.\n\n" +
      d3("D3-05").inputData,
    requiredSubtasks: [
      "extract the dependency lists per module",
      "aggregate how many modules depend on each package",
      "classify each top package as core or peripheral",
      "summarize the dependency hotspots",
    ],
    gapLeaves: [],
    scorer: { kind: "pipeline", goldTop3: d3("D3-05").goldTop3, stageChecklist: D3_STAGES },
    inputData: d3("D3-05").inputData,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// D4 — Ambiguous / recovery. Each embeds ONE unviable `sql` leaf (JOIN+GROUP BY+HAVING,
//   the characterized hard gap in escalateToFrontier) that the brain must escalate
//   *lazily* (that leaf only) then integrate. gapLeaves=["sql"]; answer is derivable.
// ─────────────────────────────────────────────────────────────────────────────

const D4_TASKS: OrchTask[] = [
  {
    id: "D4-01",
    family: "D4",
    title: "Returned-orders segment → Slack one-liner",
    prompt:
      "Using the orders table below, determine which customer segment has more than $10,000 in total RETURNED " +
      "orders (a SQL aggregation over status='returned' grouped by segment with a HAVING filter), then write a " +
      "one-line Slack message naming that segment. State the segment name explicitly.\n\n" +
      d4("D4-01").inputData,
    requiredSubtasks: [
      "run the SQL aggregation: total returned amount per segment with HAVING > 10000",
      "identify the qualifying segment",
      "draft a one-line Slack message naming the segment",
    ],
    gapLeaves: ["sql"],
    scorer: { kind: "answer-match", goldAnswer: d4("D4-01").goldAnswer },
    inputData: d4("D4-01").inputData,
  },
  {
    id: "D4-02",
    family: "D4",
    title: "High-avg-salary department → memo",
    prompt:
      "From the employees table below, find the department whose average salary exceeds 90,000 among " +
      "departments with at least 2 staff (a SQL GROUP BY with AVG and a HAVING COUNT>=2), then write a short " +
      "memo line naming it. State the department name explicitly.\n\n" +
      d4("D4-02").inputData,
    requiredSubtasks: [
      "run the SQL aggregation: avg salary per department with HAVING count>=2 and avg>90000",
      "identify the qualifying department",
      "draft a memo line naming the department",
    ],
    gapLeaves: ["sql"],
    scorer: { kind: "answer-match", goldAnswer: d4("D4-02").goldAnswer },
    inputData: d4("D4-02").inputData,
  },
  {
    id: "D4-03",
    family: "D4",
    title: "High-median-resolution priority → alert",
    prompt:
      "From the tickets table below, find the priority tier whose MEDIAN resolution time exceeds 48 hours " +
      "(a SQL aggregation grouped by priority), then write a one-line alert naming it. State the priority " +
      "explicitly.\n\n" +
      d4("D4-03").inputData,
    requiredSubtasks: [
      "run the SQL aggregation: median resolution hours per priority with the >48 filter",
      "identify the qualifying priority tier",
      "draft a one-line alert naming the priority",
    ],
    gapLeaves: ["sql"],
    scorer: { kind: "answer-match", goldAnswer: d4("D4-03").goldAnswer },
    inputData: d4("D4-03").inputData,
  },
  {
    id: "D4-04",
    family: "D4",
    title: "Region beating target by >20% → highlight",
    prompt:
      "From the sales table below, find the region whose actual sales beat its target by more than 20% " +
      "(a SQL join of actual vs target with a computed-ratio HAVING filter), then write a one-line highlight " +
      "naming it. State the region explicitly.\n\n" +
      d4("D4-04").inputData,
    requiredSubtasks: [
      "run the SQL aggregation: actual-vs-target ratio per region with the >20% filter",
      "identify the over-performing region",
      "draft a one-line highlight naming the region",
    ],
    gapLeaves: ["sql"],
    scorer: { kind: "answer-match", goldAnswer: d4("D4-04").goldAnswer },
    inputData: d4("D4-04").inputData,
  },
  {
    id: "D4-05",
    family: "D4",
    title: "Fully out-of-stock category → restock ticket",
    prompt:
      "From the inventory table below, find the category where EVERY SKU has zero stock (a SQL GROUP BY with a " +
      "HAVING that all stock = 0), then write a one-line restock ticket naming it. State the category " +
      "explicitly.\n\n" +
      d4("D4-05").inputData,
    requiredSubtasks: [
      "run the SQL aggregation: per category, detect all SKUs out of stock",
      "identify the fully out-of-stock category",
      "draft a one-line restock ticket naming the category",
    ],
    gapLeaves: ["sql"],
    scorer: { kind: "answer-match", goldAnswer: d4("D4-05").goldAnswer },
    inputData: d4("D4-05").inputData,
  },
];

/** The full 20-task orchestration set (D1–D4, 5 each). */
export const ORCH_TASKS: OrchTask[] = [...D1_TASKS, ...D2_TASKS, ...D3_TASKS, ...D4_TASKS];

export function getTask(id: string): OrchTask | undefined {
  return ORCH_TASKS.find((t) => t.id === id);
}

export function tasksByFamily(family: OrchTask["family"]): OrchTask[] {
  return ORCH_TASKS.filter((t) => t.family === family);
}
