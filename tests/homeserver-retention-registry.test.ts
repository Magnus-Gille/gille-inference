/**
 * Store-inventory tests (issue #9, scope item 1).
 */
import { describe, it, expect } from "vitest";
import {
  HARVEST_STORE_REGISTRY,
  RETENTION_DATA_CLASSES,
  getHarvestStoreDescriptor,
  prunableHarvestStores,
} from "../src/homeserver/retention-registry.js";

describe("retention-registry — harvest store inventory", () => {
  it("every storeId is unique", () => {
    const ids = HARVEST_STORE_REGISTRY.map((d) => d.storeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every descriptor's retentionDays matches its declared dataClass", () => {
    for (const d of HARVEST_STORE_REGISTRY) {
      expect(d.retentionDays).toBe(RETENTION_DATA_CLASSES[d.dataClass].retentionDays);
    }
  });

  it("every sqlite descriptor has table/timestampColumn/primaryKeyColumn (or is documented as unenforced)", () => {
    for (const d of HARVEST_STORE_REGISTRY) {
      if (d.mechanism !== "sqlite") continue;
      expect(d.table).toBeTruthy();
      if (d.prunable) {
        expect(d.timestampColumn, `${d.storeId} must have a timestampColumn to be prunable`).toBeTruthy();
        expect(d.primaryKeyColumn, `${d.storeId} must have a primaryKeyColumn to be prunable`).toBeTruthy();
      }
    }
  });

  it("a redact-content descriptor always carries at least one content column", () => {
    for (const d of HARVEST_STORE_REGISTRY) {
      if (d.pruneAction === "redact-content") {
        expect(d.contentColumns.length).toBeGreaterThan(0);
      }
    }
  });

  it("a content-blind descriptor never carries a content column", () => {
    for (const d of HARVEST_STORE_REGISTRY) {
      if (d.classification === "content-blind") {
        expect(d.contentColumns).toEqual([]);
      }
    }
  });

  it("the durable gille-accounting evidence chain is documented but never prunable", () => {
    const d = getHarvestStoreDescriptor("gille-accounting-events");
    expect(d).toBeDefined();
    expect(d?.prunable).toBe(false);
    expect(d?.pruneAction).toBe("none");
    expect(prunableHarvestStores().some((s) => s.storeId === "gille-accounting-events")).toBe(false);
  });

  it("the M5 capability ledger (delegations) implements the documented split window", () => {
    const content = getHarvestStoreDescriptor("delegations-content");
    const evidence = getHarvestStoreDescriptor("delegations-evidence");
    expect(content?.table).toBe("delegations");
    expect(evidence?.table).toBe("delegations");
    expect(content?.retentionDays).toBeLessThan(evidence?.retentionDays ?? Infinity);
    expect(content?.contentColumns).toContain("prompt_excerpt");
    expect(evidence?.contentColumns).toEqual([]);
  });

  it("owner_request_log content redaction window is shorter than its row-deletion window", () => {
    const content = getHarvestStoreDescriptor("owner-request-log");
    const row = getHarvestStoreDescriptor("owner-request-log-row");
    expect(content?.retentionDays).toBeLessThanOrEqual(row?.retentionDays ?? 0);
  });

  it("prunableHarvestStores excludes every prunable:false descriptor", () => {
    for (const d of prunableHarvestStores()) {
      expect(d.prunable).toBe(true);
    }
  });
});
