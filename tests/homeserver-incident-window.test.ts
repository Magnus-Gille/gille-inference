import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  IncidentWindowOptionsError,
  queryIncidentWindow,
  type IncidentWindowOptions,
} from "../src/homeserver/incident-window.js";

const BASE_OPTIONS: IncidentWindowOptions = {
  fromMs: 100,
  toMs: 200,
  limit: 2,
  requestLogEnabled: true,
  knownModelIds: new Set(["model-a"]),
};

const dbs: Database[] = [];

function memoryDb(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}

function createRequestLog(db: Database): void {
  db.exec(`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, alias TEXT, tier TEXT, key_hash TEXT,
      model TEXT NOT NULL, node TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
      outcome TEXT NOT NULL, error_class TEXT, admission TEXT, total_ms INTEGER NOT NULL,
      prompt TEXT, completion TEXT, raw_backend_error TEXT
    );
  `);
}

function insert(
  db: Database,
  row: {
    id: string; ts: number; alias?: string | null; tier?: string | null; keyHash?: string;
    model?: string; node?: string; route?: string; status?: number; outcome?: string;
    errorClass?: string | null; admission?: string | null; totalMs?: number;
    prompt?: string; completion?: string; rawBackendError?: string;
  },
): void {
  db.prepare(`
    INSERT INTO request_log
      (id, ts, alias, tier, key_hash, model, node, route, status, outcome, error_class,
       admission, total_ms, prompt, completion, raw_backend_error)
    VALUES
      (@id, @ts, @alias, @tier, @keyHash, @model, @node, @route, @status, @outcome,
       @errorClass, @admission, @totalMs, @prompt, @completion, @rawBackendError)
  `).run({
    id: row.id,
    ts: row.ts,
    alias: row.alias ?? "operator:pseudonym",
    tier: row.tier ?? "owner",
    keyHash: row.keyHash ?? "key-hash-secret-marker",
    model: row.model ?? "model-a",
    node: row.node ?? "m5",
    route: row.route ?? "/mcp/ask",
    status: row.status ?? 200,
    outcome: row.outcome ?? "ok",
    errorClass: row.errorClass ?? null,
    admission: row.admission ?? "admitted",
    totalMs: row.totalMs ?? 7,
    prompt: row.prompt ?? "prompt-secret-marker",
    completion: row.completion ?? "completion-secret-marker",
    rawBackendError: row.rawBackendError ?? "raw-error-secret-marker",
  });
}

function schemaSnapshot(db: Database): Array<{ type: string; name: string; sql: string | null }> {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{
    type: string; name: string; sql: string | null;
  }>;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("queryIncidentWindow", () => {
  it("reads only bounded relevant rows in stable ascending order with a closed projection", () => {
    const db = memoryDb();
    createRequestLog(db);
    // Reverse insertion order and tie timestamps to prove ordering includes id.
    insert(db, { id: "c", ts: 150, alias: "unsafe alias with spaces", model: "not-in-catalog", node: "other", route: "/mcp" });
    insert(db, { id: "b", ts: 150, alias: "owner:one", tier: "admin", model: "not-in-catalog", outcome: "raw free form", errorClass: "raw backend text", admission: "surprise", totalMs: -1 });
    insert(db, { id: "a", ts: 150, alias: "safe.alias-1", route: "/healthz", status: 700, errorClass: "internal_error" });
    insert(db, { id: "outside-low", ts: 99 });
    insert(db, { id: "outside-high", ts: 201 });
    insert(db, { id: "unrelated-route", ts: 150, route: "/admin/private" });
    db.pragma("query_only = ON");
    const before = schemaSnapshot(db);

    const result = queryIncidentWindow(db, BASE_OPTIONS);

    expect(result).toEqual({
      schema: "incident_window_v1",
      status: "available",
      from_ms: 100,
      to_ms: 200,
      coverage: "retained_rows_only",
      causality: "not_established",
      truncated: true,
      requests: [
        {
          request_id: null,
          at_ms: 150,
          caller_alias: "safe.alias-1",
          tier: "owner",
          model: "model-a",
          node: "m5",
          route: "/healthz",
          http_status: null,
          outcome: "ok",
          error_class: "internal_error",
          admission: "admitted",
          duration_ms: 7,
        },
        {
          request_id: null,
          at_ms: 150,
          caller_alias: "owner:one",
          tier: null,
          model: "unknown",
          node: "m5",
          route: "/mcp/ask",
          http_status: 200,
          outcome: "unknown",
          error_class: "unknown",
          admission: null,
          duration_ms: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/key-hash-secret-marker|prompt-secret-marker|completion-secret-marker|raw-error-secret-marker|raw free form|raw backend text|not-in-catalog/);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("preserves valid UUIDs and recognized sentinels and known model ids", () => {
    const db = memoryDb();
    createRequestLog(db);
    insert(db, {
      id: "123e4567-e89b-12d3-a456-426614174000", ts: 125,
      model: "none", route: "/v1/chat/completions", node: "orin", outcome: "busy",
      errorClass: null, admission: "busy", totalMs: 0,
    });
    const none = queryIncidentWindow(db, { ...BASE_OPTIONS, limit: 1 });
    expect(none.status).toBe("available");
    if (none.status === "available") {
      expect(none.requests[0]).toMatchObject({
        request_id: "123e4567-e89b-12d3-a456-426614174000", model: "none", node: "orin",
        outcome: "busy", error_class: null, admission: "busy", duration_ms: 0,
      });
    }
    insert(db, { id: "known", ts: 126, model: "model-a" });
    const known = queryIncidentWindow(db, { ...BASE_OPTIONS, fromMs: 126, toMs: 126, limit: 1 });
    expect(known.status).toBe("available");
    if (known.status === "available") expect(known.requests[0].model).toBe("model-a");
  });

  it("returns disabled without inspecting or querying a missing table", () => {
    const db = memoryDb();
    db.pragma("query_only = ON");
    expect(queryIncidentWindow(db, { ...BASE_OPTIONS, requestLogEnabled: false })).toEqual({
      schema: "incident_window_v1",
      status: "disabled",
      from_ms: 100,
      to_ms: 200,
      coverage: "retained_rows_only",
      causality: "not_established",
      truncated: false,
      requests: [],
    });
  });

  it("reports a missing table and a legacy table without node as unavailable without mutation", () => {
    const missingDb = memoryDb();
    missingDb.pragma("query_only = ON");
    expect(queryIncidentWindow(missingDb, BASE_OPTIONS)).toMatchObject({
      status: "unavailable", reason: "missing_request_log", requests: [],
    });

    const legacyDb = memoryDb();
    legacyDb.exec(`CREATE TABLE request_log (id TEXT, ts INTEGER, alias TEXT, tier TEXT,
      model TEXT, route TEXT, status INTEGER, outcome TEXT, error_class TEXT, admission TEXT, total_ms INTEGER)`);
    legacyDb.pragma("query_only = ON");
    const before = schemaSnapshot(legacyDb);
    expect(queryIncidentWindow(legacyDb, BASE_OPTIONS)).toMatchObject({
      status: "unavailable", reason: "unsupported_schema", requests: [],
    });
    expect(schemaSnapshot(legacyDb)).toEqual(before);
  });

  it("rejects invalid options with a fixed typed error that does not echo values", () => {
    const db = memoryDb();
    for (const invalid of [
      { ...BASE_OPTIONS, fromMs: -1 },
      { ...BASE_OPTIONS, fromMs: 1.5 },
      { ...BASE_OPTIONS, toMs: BASE_OPTIONS.fromMs - 1 },
      { ...BASE_OPTIONS, toMs: BASE_OPTIONS.fromMs + 24 * 60 * 60 * 1000 + 1 },
      { ...BASE_OPTIONS, limit: 0 },
      { ...BASE_OPTIONS, limit: 501 },
      { ...BASE_OPTIONS, requestLogEnabled: "yes" },
      { ...BASE_OPTIONS, knownModelIds: ["ok", 42] },
    ]) {
      expect(() => queryIncidentWindow(db, invalid as IncidentWindowOptions)).toThrow(IncidentWindowOptionsError);
      expect(() => queryIncidentWindow(db, invalid as IncidentWindowOptions)).toThrow("Invalid incident window options");
    }
  });

  it("rethrows unexpected database failures", () => {
    const db = memoryDb();
    createRequestLog(db);
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("FROM request_log")) throw new Error("unexpected failure");
      return prepare(sql);
    }) as Database["prepare"];
    expect(() => queryIncidentWindow(db, BASE_OPTIONS)).toThrow("unexpected failure");
  });
});
