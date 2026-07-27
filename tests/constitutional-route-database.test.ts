import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConstitutionalRouteDatabase,
  initializeConstitutionalRouteDatabase,
} from "../src/homeserver/constitutional-route-database.js";

describe("constitutional route resource fencing", () => {
  it("rejects the predecessor after the successor acquires at the resource before any separate claim", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-route-db-")), "routing.db");
    const baseline = '{"route":"mellum"}\n';
    const candidate = '{"route":"qwen"}\n';
    initializeConstitutionalRouteDatabase(path, baseline);
    const route = new ConstitutionalRouteDatabase(path);
    const firstLease = route.acquireWriterLease({ durationMs: 20 });
    const first = { epoch: firstLease.epoch, token: firstLease.token };

    // Epoch 1 performed every possible client-side read/check here, then was
    // stopped. After expiry, epoch 2 acquisition itself advances the lease in
    // the authoritative route DB; there is no acquisition -> claim window.
    expect(route.read()).toBe(baseline);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondLease = route.acquireWriterLease({ durationMs: 2_000 });
    const second = { epoch: secondLease.epoch, token: secondLease.token };

    expect(route.compareAndSwap(baseline, candidate, first)).toBe(false);
    expect(route.read()).toBe(baseline);
    expect(route.compareAndSwap(baseline, candidate, second)).toBe(true);
    expect(route.read()).toBe(candidate);
    firstLease.release();
    secondLease.release();
  });

  it("refuses a test clock or boot ID that could diverge from resource-side validation", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-route-db-")), "routing.db");
    initializeConstitutionalRouteDatabase(path, "{}");
    const route = new ConstitutionalRouteDatabase(path);
    expect(() => route.acquireWriterLease({ monotonicNowNs: () => 1n })).toThrow(/host monotonic clock/);
    expect(() => route.acquireWriterLease({ bootId: "test-boot" })).toThrow(/boot ID/);
  });

  it("persists the fail-closed serving guard under the resource-local fence", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-route-db-")), "routing.db");
    initializeConstitutionalRouteDatabase(path, "{}");
    const route = new ConstitutionalRouteDatabase(path);
    const first = route.acquireWriterLease();
    const firstFence = { epoch: first.epoch, token: first.token };
    expect(route.block(firstFence)).toBe(true);
    expect(route.isBlocked()).toBe(true);
    first.release();
    const successor = route.acquireWriterLease();
    const successorFence = { epoch: successor.epoch, token: successor.token };
    expect(route.clearBlock(firstFence)).toBe(false);
    expect(route.isBlocked()).toBe(true);
    expect(route.clearBlock(successorFence)).toBe(true);
    expect(route.isBlocked()).toBe(false);
    successor.release();
  });
});
