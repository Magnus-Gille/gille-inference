/**
 * TDD for the offloadability trend → Heimdall typed-panel pipeline.
 * Red first: written BEFORE buildTrendRecord / buildPanelPayload exist.
 *
 *   buildTrendRecord  — gate-chat-replay's per-night structured summary (→ trend JSONL)
 *   buildPanelPayload — turns the accumulated JSONL records into the Heimdall
 *                       `POST /api/panels` typed-panel envelope (timeseries + detail table)
 */
import { describe, it, expect } from "vitest";
import { buildTrendRecord, resultsOutputPath, DEFAULT_MIN_RELIABLE_N } from "../scripts/gate-chat-replay.js";
import { buildPanelPayload, isTrendRecord } from "../scripts/post-offloadability-panel.js";

describe("buildTrendRecord", () => {
  const base = {
    nowIso: "2026-06-27T03:00:05.000Z",
    windowShort: "24h",
    okCount: 60,
    errCount: 3,
    wouldEscalateCount: 1,
    byModel: [
      { model: "qwen3-30b-instruct", n: 52, esc: 0 },
      { model: "qwen35-a3b", n: 1, esc: 1 },
    ],
    byTaskType: [
      { taskType: "extract", n: 52, esc: 0 },
      { taskType: "other", n: 1, esc: 1 },
    ],
    sampledTsSorted: ["2026-06-26T10:18:40.581Z", "2026-06-27T01:19:08.880Z"],
  };

  it("derives date from the run timestamp", () => {
    expect(buildTrendRecord(base).date).toBe("2026-06-27");
  });
  it("computes fire-rate as a 1-decimal percent of OK runs", () => {
    expect(buildTrendRecord(base).fireRatePct).toBe(1.7); // 1/60 → 1.666… → 1.7
  });
  it("is 0 when there were no scored runs (no divide-by-zero)", () => {
    expect(buildTrendRecord({ ...base, okCount: 0, wouldEscalateCount: 0 }).fireRatePct).toBe(0);
  });
  it("renders byModel as model + esc/n strings", () => {
    expect(buildTrendRecord(base).byModel).toEqual([
      { model: "qwen3-30b-instruct", disagree: "0/52" },
      { model: "qwen35-a3b", disagree: "1/1" },
    ]);
  });

  // #201: the nightly fire-rate spiked 7.5%→94.7% and the ONLY durable, non-overwritable record
  // was the aggregate fireRatePct — diagnosing it required reconstructing per-task-type detail
  // from an append-only console log because the per-request JSONL (data/gate-chat-replay-<n>.jsonl,
  // named by sample size) gets silently overwritten whenever two nights share the same n. A
  // byTaskType breakdown in the trend spine itself (mirroring byModel, which already survives)
  // makes a future traffic-mix shift visible from data/gate-chat-replay-trend.jsonl alone.
  it("renders byTaskType as taskType + esc/n strings, mirroring byModel", () => {
    expect(buildTrendRecord(base).byTaskType).toEqual([
      { taskType: "extract", disagree: "0/52" },
      { taskType: "other", disagree: "1/1" },
    ]);
  });
  it("defaults byTaskType to [] when omitted (backward-compatible call sites)", () => {
    const { byTaskType: _drop, ...noTaskType } = base;
    expect(buildTrendRecord(noTaskType).byTaskType).toEqual([]);
  });
  it("carries the window tag, n, errors, and sampled ts range", () => {
    const r = buildTrendRecord(base);
    expect(r.window).toBe("24h");
    expect(r.n).toBe(60);
    expect(r.secondaryErrors).toBe(3);
    expect(r.sampledFrom).toBe("2026-06-26T10:18:40.581Z");
    expect(r.sampledTo).toBe("2026-06-27T01:19:08.880Z");
  });
  it("tolerates an empty sample (null range)", () => {
    const r = buildTrendRecord({ ...base, sampledTsSorted: [] });
    expect(r.sampledFrom).toBeNull();
    expect(r.sampledTo).toBeNull();
  });

  // A real anomaly caught during an overnight review: the nightly trend degraded to n=3-5 while
  // fireRatePct hit 100% — statistically meaningless on that few samples, but a bare percentage
  // in a log/panel gives no hint of that. lowSample makes the unreliability explicit and queryable.
  describe("lowSample — flags a statistically unreliable run", () => {
    it("is false at the default threshold when okCount is comfortably above it", () => {
      expect(buildTrendRecord(base).lowSample).toBe(false); // okCount 60
    });
    it("is true when okCount is below the default threshold (e.g. the n=3 real-world case)", () => {
      expect(buildTrendRecord({ ...base, okCount: 3, wouldEscalateCount: 3 }).lowSample).toBe(true);
    });
    it("the boundary is exclusive: exactly DEFAULT_MIN_RELIABLE_N is NOT low-sample", () => {
      expect(buildTrendRecord({ ...base, okCount: DEFAULT_MIN_RELIABLE_N }).lowSample).toBe(false);
      expect(buildTrendRecord({ ...base, okCount: DEFAULT_MIN_RELIABLE_N - 1 }).lowSample).toBe(true);
    });
    it("respects an explicit minReliableN override", () => {
      expect(buildTrendRecord({ ...base, okCount: 10, minReliableN: 5 }).lowSample).toBe(false);
      expect(buildTrendRecord({ ...base, okCount: 10, minReliableN: 15 }).lowSample).toBe(true);
    });
  });
});

describe("buildPanelPayload", () => {
  const recs = [
    { ts: "2026-06-26T03:00:00.000Z", date: "2026-06-26", window: "24h", n: 58, secondaryErrors: 0, wouldEscalate: 2, fireRatePct: 3.4, byModel: [{ model: "a", disagree: "2/58" }], sampledFrom: null, sampledTo: null, lowSample: false },
    { ts: "2026-06-27T03:00:00.000Z", date: "2026-06-27", window: "24h", n: 60, secondaryErrors: 3, wouldEscalate: 1, fireRatePct: 1.7, byModel: [{ model: "qwen3-30b-instruct", disagree: "0/52" }], sampledFrom: null, sampledTo: null, lowSample: false },
  ];

  it("emits a valid typed-panel envelope (ids match Heimdall's pattern)", () => {
    const p = buildPanelPayload(recs);
    expect(p.service).toBe("m5-inference");
    expect(p.panel).toBe("offloadability");
    expect(p.kind).toBe("timeseries");
    expect(p.unit).toBe("percent");
    expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.service)).toBe(true);
    expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.panel)).toBe(true);
  });
  it("maps each record to a {t,y} point in order", () => {
    expect(buildPanelPayload(recs).points).toEqual([
      { t: "2026-06-26", y: 3.4 },
      { t: "2026-06-27", y: 1.7 },
    ]);
  });
  it("summary + detail come from the LATEST record", () => {
    const p = buildPanelPayload(recs);
    expect(p.summary).toEqual({ latest: 1.7, window: "24h", n: 60, lowSample: false });
    expect(p.detail).toEqual({ kind: "table", rows: [{ model: "qwen3-30b-instruct", disagree: "0/52" }] });
  });
  it("propagates lowSample:true from the latest record so a viewer isn't misled by a bare percentage", () => {
    const lowN = [...recs, { ...recs[1], date: "2026-06-28", n: 3, wouldEscalate: 3, fireRatePct: 100, lowSample: true }];
    const p = buildPanelPayload(lowN);
    expect(p.summary?.lowSample).toBe(true);
    expect(p.summary?.latest).toBe(100);
    expect(p.summary?.n).toBe(3);
  });
  it("BACKWARD COMPAT: a historical record with no lowSample field gets it derived from n (the real box data predates this field)", () => {
    // Exactly the shape of the real data/gate-chat-replay-trend.jsonl rows from before this fix —
    // e.g. the actual 2026-06-30/07-01 rows that motivated it: n=5/n=3, fireRatePct=100, no
    // lowSample key at all. Without this fallback those exact rows would silently read as "fine".
    const { lowSample: _drop, ...legacyShape } = recs[1];
    const legacy = { ...legacyShape, date: "2026-06-30", n: 5, wouldEscalate: 5, fireRatePct: 100 };
    const p = buildPanelPayload([recs[0], legacy as (typeof recs)[number]]);
    expect(p.summary?.lowSample).toBe(true);
  });
  it("dedups by date, keeping the last occurrence (re-runs don't double a day)", () => {
    const dup = [...recs, { ...recs[1], fireRatePct: 2.0 }];
    const p = buildPanelPayload(dup);
    expect(p.points).toEqual([
      { t: "2026-06-26", y: 3.4 },
      { t: "2026-06-27", y: 2.0 },
    ]);
  });
  it("excludes non-windowed (all-time) records so the series stays consistent", () => {
    const mixed = [{ ...recs[0], window: "all-time" }, recs[1]];
    expect(buildPanelPayload(mixed).points).toEqual([{ t: "2026-06-27", y: 1.7 }]);
  });
  it("caps points to the LAST 500 (keeps newest, by date order)", () => {
    // ISO dates so the YYYY-MM-DD lexical ordering contract is actually exercised.
    const many = Array.from({ length: 600 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { ...recs[1], date: d, fireRatePct: i };
    });
    const pts = buildPanelPayload(many).points;
    expect(pts.length).toBe(500);
    expect(pts[0].y).toBe(100); // dropped the first 100 (0..99), kept 100..599
    expect(pts[pts.length - 1].y).toBe(599);
  });
});

describe("isTrendRecord", () => {
  const good = { ts: "x", date: "2026-06-27", window: "24h", n: 60, secondaryErrors: 0, wouldEscalate: 1, fireRatePct: 1.7, byModel: [], sampledFrom: null, sampledTo: null };
  it("accepts a well-formed record", () => expect(isTrendRecord(good)).toBe(true));
  it("rejects non-objects", () => {
    expect(isTrendRecord(null)).toBe(false);
    expect(isTrendRecord("{}")).toBe(false);
    expect(isTrendRecord(42)).toBe(false);
  });
  it("rejects {} and partial records", () => {
    expect(isTrendRecord({})).toBe(false);
    expect(isTrendRecord({ ...good, date: 123 })).toBe(false);
    expect(isTrendRecord({ ...good, fireRatePct: "1.7" })).toBe(false);
    expect(isTrendRecord({ ...good, byModel: "nope" })).toBe(false);
  });
});

// #201 forensics: the per-request detail file (data/gate-chat-replay-<n>.jsonl, named only by
// sample size) silently overwrote itself across nights that happened to sample the same n —
// during the #201 investigation this destroyed the 2026-06-27/28/29 and 07-04 per-request
// evidence needed to see the task-type mix shift, leaving only the console log (not designed to
// be machine-read) to reconstruct it. Date-stamping the filename makes two nights' detail
// coexist regardless of n.
describe("resultsOutputPath", () => {
  it("includes the FULL run timestamp (filesystem-safe) so no two runs collide", () => {
    expect(resultsOutputPath("2026-07-06T03:11:45.000Z", 36)).toBe(
      "data/gate-chat-replay-2026-07-06T03-11-45-000Z-36.jsonl"
    );
  });
  it("two different dates with the SAME n produce two different paths", () => {
    const a = resultsOutputPath("2026-06-27T03:00:01.000Z", 60);
    const b = resultsOutputPath("2026-06-28T03:00:01.000Z", 60);
    expect(a).not.toBe(b);
  });
  it("a same-day manual rerun with the SAME n does not overwrite the nightly's evidence", () => {
    const nightly = resultsOutputPath("2026-07-06T03:11:45.000Z", 36);
    const rerun = resultsOutputPath("2026-07-06T14:02:07.500Z", 36);
    expect(rerun).not.toBe(nightly);
  });
});
