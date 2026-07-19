/**
 * TDD for issue #216: sanitizeMessages coerced `tool` (and every unknown role) to `user`, so on
 * agentic rows (user ask → assistant tool_call → tool result → …) the LAST message — a tool
 * RESULT — became the last "user" turn: selected as the judged/classified TASK, used as the dedup
 * key, and presented to the judge as "the user's latest message" while the real human ask slid
 * into prior context (live evidence: row #6100, the 18-message pi-harness tool-loop). Red first:
 * written BEFORE the sanitizer preserves `tool` / `toReplayMessages` exists.
 *
 * The replay payload is deliberately UNCHANGED: `toReplayMessages` coerces tool→user at SEND time
 * (the sanitizer strips tool_call_id, so a bare role:"tool" message is chat-template-hostile),
 * keeping the secondary's input byte-identical to the pre-#216 behavior while task identity,
 * classification, and the dedup key upstream now see the true roles.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadChatRequests,
  toReplayMessages,
  buildTrendRecord,
  LOADER_POLICY,
} from "../scripts/gate-chat-replay.js";
import { isTrendRecord } from "../scripts/post-offloadability-panel.js";

const SECONDARY = "qwen-secondary";

// Human ask and tool result are crafted to classify DIFFERENTLY (same keyword shapes as the
// existing task-types fixture): the ask is an `extract`, the tool result would classify as
// `classify` — so a coercing loader is caught by the taskType assertion, not just by roles.
const HUMAN_ASK = "extract the value number 7 from this record";
const TOOL_RESULT_A = "classify the sentiment of message number 1 today";
const TOOL_RESULT_B = "classify the sentiment of message number 2 today";
const TOOL_RESULT_C = "classify the sentiment of message number 3 today";

describe("loadChatRequests — tool-role preservation & task identity (#216)", () => {
  let dbPath: string;

  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "gate-replay-toolrole-db-")), "eval.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE owner_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL,
      model TEXT, route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
      outcome TEXT NOT NULL);`);
    const ins = db.prepare(
      `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome)
       VALUES (@ts,'owner','primary-a','chat',@mj,@completion,2,'ok')`
    );
    // id=1 — agentic row ENDING IN A TOOL RESULT, with an assistant tool_call stub (content null)
    // mid-sequence, exactly the shape the owner log records for a pi-harness tool loop.
    ins.run({
      ts: "2026-07-01T10:00:00.000Z",
      mj: JSON.stringify([
        { role: "system", content: "You are an agent with tools." },
        { role: "user", content: HUMAN_ASK },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" }] },
        { role: "tool", tool_call_id: "c1", content: TOOL_RESULT_A },
      ]),
      completion: "the value is 7",
    });
    // id=2 — SAME human ask, different tool result: must dedupe against id=1 (key = the ask, not
    // the tool result — under the old coercion both survived because the keys differed).
    ins.run({
      ts: "2026-07-01T11:00:00.000Z",
      mj: JSON.stringify([
        { role: "user", content: HUMAN_ASK },
        { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function" }] },
        { role: "tool", tool_call_id: "c2", content: TOOL_RESULT_B },
      ]),
      completion: "the value is 7",
    });
    // id=3 — NO genuine human turn at all (system + assistant + tool): under the old coercion the
    // tool result posed as the user task; now the row has no task and must be skipped.
    ins.run({
      ts: "2026-07-01T12:00:00.000Z",
      mj: JSON.stringify([
        { role: "system", content: "You are an agent with tools." },
        { role: "assistant", content: "calling the tool now" },
        { role: "tool", tool_call_id: "c3", content: TOOL_RESULT_C },
      ]),
      completion: "done",
    });
    // id=4 — plain single-turn control row: eligibility unchanged by #216.
    ins.run({
      ts: "2026-07-01T13:00:00.000Z",
      mj: JSON.stringify([{ role: "user", content: "classify the sentiment of message number 9 today" }]),
      completion: "neutral",
    });
    // id=5 — full agentic shape with a UNIQUE ask (so the dedup pair above can't absorb it):
    // system contract, human ask, assistant tool_call stub (content null), trailing tool result.
    ins.run({
      ts: "2026-07-01T14:00:00.000Z",
      mj: JSON.stringify([
        { role: "system", content: "You are an agent with tools." },
        { role: "user", content: "extract the value number 8 from this record" },
        { role: "assistant", content: null, tool_calls: [{ id: "c5", type: "function" }] },
        { role: "tool", tool_call_id: "c5", content: "classify the sentiment of message number 4 today" },
      ]),
      completion: "the value is 8",
    });
    db.close();
  });

  it("preserves the tool role through sanitization (not coerced to user); the content-null tool_call stub stays dropped", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const agentic = rows.find((r) => r.id === 5);
    expect(agentic).toBeDefined();
    expect(agentic!.messages.map((m) => m.role)).toEqual(["system", "user", "tool"]);
    expect(agentic!.messages.at(-1)!.content).toBe("classify the sentiment of message number 4 today");
  });

  it("classifies the task from the HUMAN ask, not the trailing tool result", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const agentic = rows.find((r) => r.id === 5);
    // The ask is an `extract`; the tool result would classify as `classify` — the old coercion
    // classified the tool result.
    expect(agentic!.taskType).toBe("extract");
  });

  it("dedupes on the human ask: same ask + different tool results collapse to one row", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    expect(rows.filter((r) => [1, 2].includes(r.id)).length).toBe(1);
  });

  it("skips a row with no genuine human turn (tool result must not pose as the task)", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    expect(rows.find((r) => r.id === 3)).toBeUndefined();
  });

  it("plain single-turn rows are unaffected", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const plain = rows.find((r) => r.id === 4);
    expect(plain).toBeDefined();
    expect(plain!.taskType).toBe("classify");
  });
});

describe("loadChatRequests — array-of-parts content is flattened to text (#222)", () => {
  const PARTS_ASK = "extract the value number 11 from this record";
  let dbPath: string;

  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "gate-replay-parts-db-")), "eval.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE owner_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL,
      model TEXT, route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
      outcome TEXT NOT NULL);`);
    const ins = db.prepare(
      `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome)
       VALUES (@ts,'owner','primary-a','chat',@mj,@completion,2,'ok')`
    );
    // id=1 — the live #6191 shape: the genuine ask is a single {type:"text"} part; the sanitizer
    // used to drop the whole turn, excluding the row (post-#216) or letting the tool result pose
    // as the task (pre-#216).
    ins.run({
      ts: "2026-07-01T10:00:00.000Z",
      mj: JSON.stringify([
        { role: "system", content: "You are an agent with tools." },
        { role: "user", content: [{ type: "text", text: PARTS_ASK }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" }] },
        { role: "tool", tool_call_id: "c1", content: TOOL_RESULT_A },
      ]),
      completion: "the value is 11",
    });
    // id=2 — multiple text parts join in order; interleaved non-text parts are ignored.
    ins.run({
      ts: "2026-07-01T11:00:00.000Z",
      mj: JSON.stringify([
        {
          role: "user",
          content: [
            { type: "text", text: "extract the value number 12" },
            { type: "image_url", image_url: { url: "data:image/png;base64,xxxx" } },
            { type: "text", text: "from this record please" },
          ],
        },
      ]),
      completion: "the value is 12",
    });
    // id=3 — parts with NO text (image only): still no genuine user turn → row skipped.
    ins.run({
      ts: "2026-07-01T12:00:00.000Z",
      mj: JSON.stringify([
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xxxx" } }] },
        { role: "assistant", content: "described the image" },
      ]),
      completion: "described",
    });
    // id=4 — malformed parts must not crash the loader (and yield no usable turn).
    ins.run({
      ts: "2026-07-01T13:00:00.000Z",
      mj: JSON.stringify([
        { role: "user", content: [null, { type: "text" }, { text: "no type field" }, 42] },
        { role: "assistant", content: "ok" },
      ]),
      completion: "ok",
    });
    // id=5 — plain STRING content with significant whitespace: must survive byte-for-byte
    // (#222 review: the fire-rate trend's comparability rests on string rows being untouched).
    ins.run({
      ts: "2026-07-01T14:00:00.000Z",
      mj: JSON.stringify([
        { role: "user", content: "extract the value number 13 from this record\n\n\tindented detail line  " },
      ]),
      completion: "the value is 13",
    });
    db.close();
  });

  it("flattens a single text part into the genuine ask: row eligible, task classified from it, tool role intact", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const agentic = rows.find((r) => r.id === 1);
    expect(agentic).toBeDefined();
    expect(agentic!.taskType).toBe("extract");
    expect(agentic!.messages.map((m) => m.role)).toEqual(["system", "user", "tool"]);
    expect(agentic!.messages[1]!.content).toBe(PARTS_ASK);
  });

  it("joins multiple text parts in order, ignoring non-text parts", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const multi = rows.find((r) => r.id === 2);
    expect(multi).toBeDefined();
    expect(multi!.messages[0]!.content).toBe("extract the value number 12\nfrom this record please");
    expect(multi!.taskType).toBe("extract");
  });

  it("parts with no text (image-only) still yield no genuine user turn → row skipped", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    expect(rows.find((r) => r.id === 3)).toBeUndefined();
  });

  it("malformed parts do not crash and yield no usable turn", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    expect(rows.find((r) => r.id === 4)).toBeUndefined();
  });

  it("plain string content survives byte-for-byte, whitespace and all (#222 review lock-in)", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const plain = rows.find((r) => r.id === 5);
    expect(plain).toBeDefined();
    expect(plain!.messages[0]!.content).toBe(
      "extract the value number 13 from this record\n\n\tindented detail line  "
    );
  });

  it("a LOADED parts row through toReplayMessages: flattened ask as user, tool coerced, exact sequence (#222 review lock-in)", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    const agentic = rows.find((r) => r.id === 1)!;
    const out = toReplayMessages(agentic.messages);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(out.map((m) => m.content)).toEqual([
      "You are an agent with tools.",
      PARTS_ASK,
      TOOL_RESULT_A,
    ]);
  });
});

describe("trend record loader-policy stamp (#222 review)", () => {
  const base = {
    nowIso: "2026-07-11T12:00:00.000Z",
    windowShort: "24h",
    okCount: 10,
    errCount: 0,
    wouldEscalateCount: 3,
    byModel: [{ model: "m", n: 10, esc: 3 }],
    sampledTsSorted: ["2026-07-11T00:00:00.000Z", "2026-07-11T11:00:00.000Z"],
  };

  it("every new trend record carries the loader interpretation-policy epoch", () => {
    const rec = buildTrendRecord(base) as Record<string, unknown>;
    expect(rec.loaderPolicy).toBe(LOADER_POLICY);
    expect(LOADER_POLICY).toBe("content-parts-v1");
  });

  it("isTrendRecord still accepts a stamped record (append-only spine stays readable downstream)", () => {
    expect(isTrendRecord(buildTrendRecord(base))).toBe(true);
  });
});

describe("toReplayMessages — replay payload keeps the pre-#216 shape", () => {
  it("coerces tool → user at send time, preserving order, content, and the other roles", () => {
    const out = toReplayMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "ask" },
      { role: "tool", content: "tool result" },
      { role: "assistant", content: "answer" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user", "assistant"]);
    expect(out.map((m) => m.content)).toEqual(["sys", "ask", "tool result", "answer"]);
  });
});
