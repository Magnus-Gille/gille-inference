import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendModelLifecycleEvent,
  ensureModelLifecycleSchema,
  MODEL_LIFECYCLE_CAUSE,
  MODEL_LIFECYCLE_COLUMNS,
  MODEL_LIFECYCLE_TABLE,
  readModelLifecycleEvents,
  reconcileModelLifecycleSnapshots,
  type SanitizedModelSnapshotEntry,
} from "../src/homeserver/model-lifecycle.js";

const databases: Database.Database[] = [];

function db(): Database.Database {
  const value = new Database(":memory:");
  databases.push(value);
  ensureModelLifecycleSchema(value);
  return value;
}

function snapshot(overrides: Partial<SanitizedModelSnapshotEntry> = {}): SanitizedModelSnapshotEntry {
  return {
    model: "qwen-main",
    state: "loading",
    ttlSeconds: 60,
    ...overrides,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("model lifecycle store", () => {
  it("creates exactly the six content-blind columns", () => {
    const database = db();
    const columns = database
      .prepare(`PRAGMA table_info(${MODEL_LIFECYCLE_TABLE})`)
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual([...MODEL_LIFECYCLE_COLUMNS]);
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(MODEL_LIFECYCLE_TABLE))
      .toMatchObject({ sql: expect.not.stringMatching(/alias|request|hash|content|token|ip|cmd|proxy|secret/i) });
  });

  it("persists only the fixed event set and safe observation fields", () => {
    const database = db();
    appendModelLifecycleEvent(
      {
        ts: "2026-08-10T12:00:00.000Z",
        model: "qwen-main",
        event: "ready",
        state: "ready",
        ttlSeconds: null,
        cause: MODEL_LIFECYCLE_CAUSE,
      },
      database,
    );

    const row = database.prepare(`SELECT * FROM ${MODEL_LIFECYCLE_TABLE}`).get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([...MODEL_LIFECYCLE_COLUMNS].sort());
    expect(readModelLifecycleEvents(database)).toEqual([
      {
        ts: "2026-08-10T12:00:00.000Z",
        model: "qwen-main",
        event: "ready",
        state: "ready",
        ttlSeconds: null,
        cause: "snapshot",
      },
    ]);
    expect(JSON.stringify(row)).not.toMatch(/alias|request|hash|content|token|ip|cmd|proxy|secret/i);
  });

  it("rejects a raw field and a non-fixed cause at the persistence boundary", () => {
    const database = db();
    const unsafe = {
      ts: "2026-08-10T12:00:00.000Z",
      model: "qwen-main",
      event: "ready",
      state: "ready",
      ttlSeconds: null,
      cause: MODEL_LIFECYCLE_CAUSE,
      cmd: "private command",
    };
    expect(() => appendModelLifecycleEvent(unsafe as never, database)).toThrow(/outside/);
    const { cmd: _forbiddenCmd, ...withoutCmd } = unsafe;
    expect(() => appendModelLifecycleEvent({ ...withoutCmd, cause: "restart" } as never, database))
      .toThrow(/fixed/);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM ${MODEL_LIFECYCLE_TABLE}`).get()).toEqual({ count: 0 });
  });
});

describe("model lifecycle reconciliation", () => {
  it("emits load, ready, unload, then disappeared without inferring crash or restart", () => {
    const loading = [snapshot()];
    const ready = [snapshot({ state: "ready", ttlSeconds: 30 })];
    const unloading = [snapshot({ state: "unloading", ttlSeconds: null })];

    expect(reconcileModelLifecycleSnapshots([], loading)).toEqual([
      { model: "qwen-main", event: "load", state: "loading", ttlSeconds: 60, cause: "snapshot" },
    ]);
    expect(reconcileModelLifecycleSnapshots(loading, ready)).toEqual([
      { model: "qwen-main", event: "ready", state: "ready", ttlSeconds: 30, cause: "snapshot" },
    ]);
    expect(reconcileModelLifecycleSnapshots(ready, unloading)).toEqual([
      { model: "qwen-main", event: "unload", state: "unloading", ttlSeconds: null, cause: "snapshot" },
    ]);
    expect(reconcileModelLifecycleSnapshots(unloading, [])).toEqual([
      { model: "qwen-main", event: "disappeared", state: "unknown", ttlSeconds: null, cause: "snapshot" },
    ]);
    expect(JSON.stringify(reconcileModelLifecycleSnapshots(unloading, []))).not.toMatch(/crash|restart/i);
  });

  it("deduplicates exact unchanged observations but preserves changed TTL observations", () => {
    const first = [snapshot()];
    expect(reconcileModelLifecycleSnapshots(first, [snapshot()])).toEqual([]);
    expect(reconcileModelLifecycleSnapshots(first, [snapshot({ ttlSeconds: 61 })])).toEqual([
      { model: "qwen-main", event: "load", state: "loading", ttlSeconds: 61, cause: "snapshot" },
    ]);
  });

  it("keeps an unknown observed state unknown and never fabricates a failure cause", () => {
    const transitions = reconcileModelLifecycleSnapshots([], [snapshot({ state: "unknown" })]);
    expect(transitions).toEqual([
      { model: "qwen-main", event: "load", state: "unknown", ttlSeconds: 60, cause: "snapshot" },
    ]);
    expect(JSON.stringify(transitions)).not.toMatch(/crash|restart|failed/i);
  });

  it("rejects extra raw snapshot fields and duplicate canonical models", () => {
    expect(() => reconcileModelLifecycleSnapshots([], [{ ...snapshot(), proxy: "private" } as never]))
      .toThrow(/outside/);
    expect(() => reconcileModelLifecycleSnapshots([], [snapshot(), snapshot({ ttlSeconds: null })]))
      .toThrow(/duplicate/);
  });
});
