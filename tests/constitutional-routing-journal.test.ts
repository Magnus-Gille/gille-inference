import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConstitutionalRoutingJournal, type RouteTableStore } from "../src/homeserver/constitutional-routing-journal.js";

function store(initial: string): { value: () => string; store: RouteTableStore } {
  let value = initial;
  return { value: () => value, store: { read: () => value, write: (next) => { value = next; }, compareAndSwap: (expected, next) => { if (value !== expected) return false; value = next; return true; } } };
}
const mutation = { id: "micro-route-canary", deadline: "2026-07-26T01:00:00.000Z", watchDeadline: "2026-07-26T00:30:00.000Z", baseline: '{"route":"mellum"}', candidate: '{"route":"qwen"}' };

describe("constitutional micro-routing journal", () => {
  it("persists the exact baseline before apply and restores it once after a crash", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    const first = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T00:00:00.000Z");
    first.prepare(mutation);
    s.store.write(mutation.candidate); // kill -9 after external write, before apply receipt
    const recovered = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T01:00:01.000Z");
    expect(recovered.recover("deadline")).toMatchObject({ outcome: "reverted", disarmed: true });
    expect(s.value()).toBe(mutation.baseline);
    expect(recovered.recover("repeat")).toMatchObject({ outcome: "terminally-blocked", disarmed: true });
  });

  it("rejects late mutations and commits only after the full watch window", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T00:00:00.000Z");
    journal.prepare(mutation); journal.apply(); journal.verify(); journal.watch();
    expect(() => journal.commit("2026-07-26T00:29:59.999Z")).toThrow(/watch/i);
    expect(journal.commit("2026-07-26T00:30:00.000Z")).toMatchObject({ outcome: "committed", disarmed: false });
  });

  it("resumes a completed watch before deadline without invoking a legacy watchdog", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-")); const s = store(mutation.baseline);
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T00:00:00.000Z");
    journal.prepare(mutation); journal.apply(); journal.verify(); journal.watch();
    expect(journal.resume("2026-07-26T00:30:00.000Z")).toMatchObject({ outcome: "committed", disarmed: false });
  });

  it("fails closed and terminally disarms when exact restore cannot be proven", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    let value = mutation.baseline;
    const s: RouteTableStore = { read: () => value, write: () => { value = "corrupt"; }, compareAndSwap: () => false };
    const journal = new ConstitutionalRoutingJournal(root, s, () => "2026-07-26T00:00:00.000Z");
    journal.prepare(mutation);
    expect(journal.recover("unknown")).toMatchObject({ outcome: "terminally-blocked", disarmed: true });
  });

  it("accepts the Grimnir RFC3339 Z timestamps and records unknown before an R-exact recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T00:00:00Z");
    journal.prepare({ ...mutation, deadline: "2026-07-26T01:00:00Z", watchDeadline: "2026-07-26T00:30:00Z" });
    expect(journal.recover("simulated-interruption")).toMatchObject({ outcome: "reverted", disarmed: true });
  });

  it("uses the route table CAS rather than a split read/write apply", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    let value = mutation.baseline;
    let casCalls = 0;
    const table: RouteTableStore = {
      read: () => value,
      write: (next) => { value = next; },
      compareAndSwap: (expected, next) => { casCalls += 1; if (value !== expected) return false; value = next; return true; },
    };
    const journal = new ConstitutionalRoutingJournal(root, table, () => "2026-07-26T00:00:00.000Z");
    journal.prepare(mutation);
    expect(journal.apply()).toMatchObject({ outcome: "applied" });
    expect(casCalls).toBe(1);
  });

  it("rejects a non-date timestamp as a diagnostic validation error", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => "not-a-date");
    expect(() => journal.prepare(mutation)).toThrow(/invalid UTC timestamp: not-a-date/);
  });

  it("terminally recovers when the exact baseline CAS fails instead of retrying apply", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T00:00:00.000Z");
    journal.prepare(mutation);
    s.store.write('{"route":"unexpected"}');
    expect(journal.apply()).toMatchObject({ outcome: "reverted", disarmed: true });
    expect(s.value()).toBe(mutation.baseline);
  });

  it("recovers rather than merely throwing when the deadline passes before apply", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    let now = "2026-07-26T00:00:00.000Z";
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => now);
    journal.prepare(mutation);
    now = "2026-07-26T01:00:00.000Z";
    expect(journal.apply()).toMatchObject({ outcome: "reverted", disarmed: true });
  });

  it("does not append new receipts after terminal recovery has been consumed", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-journal-"));
    const s = store(mutation.baseline);
    const journal = new ConstitutionalRoutingJournal(root, s.store, () => "2026-07-26T00:00:00.000Z");
    journal.prepare(mutation);
    expect(journal.recover("first")).toMatchObject({ outcome: "reverted", disarmed: true });
    const path = join(root, "autonomy-constitution", "micro-routing-journal.json");
    const before = (JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] }).entries.length;
    expect(journal.recover("repeat")).toMatchObject({ outcome: "terminally-blocked", disarmed: true });
    const after = (JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] }).entries.length;
    expect(after).toBe(before);
  });
});
