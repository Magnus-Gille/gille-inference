import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConstitutionalRouteBlockedError,
  ConstitutionalRouteDatabase,
  initializeConstitutionalRouteDatabase,
  readConstitutionalRouteDatabase,
} from "../src/homeserver/constitutional-route-database.js";
import { routingTarget } from "../src/homeserver/routing-table.js";
import { createHash } from "node:crypto";
import { currentConstitutionalBootId } from "../src/homeserver/constitutional-fenced-lease.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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

  it("fails closed at the durable candidate deadline even with no watchdog, and clears only on exact commit or revert", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-route-db-")), "routing.db");
    const baseline = JSON.stringify({ routing: { summarize: { model: "mellum", passRate: 1, tokPerSec: 1, verdict: "delegate-local" } } });
    const candidate = JSON.stringify({ routing: { summarize: { model: "qwen", passRate: 1, tokPerSec: 1, verdict: "delegate-local" } } });
    initializeConstitutionalRouteDatabase(path, baseline);
    const route = new ConstitutionalRouteDatabase(path);
    const lease = route.acquireWriterLease();
    const fence = { epoch: lease.epoch, token: lease.token };
    const deadline = "2030-07-26T01:10:00Z";
    const candidateDeadline = {
      journalId: "micro-route-journal",
      attemptId: "micro-route-attempt",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      candidateDigest: digest(candidate),
      notAfter: deadline,
    };
    expect(route.compareAndSwap(baseline, candidate, fence, candidateDeadline)).toBe(true);

    const at = Date.parse(deadline);
    const clock = (wallNowMs: number) => ({
      wallNowMs: () => wallNowMs,
      bootId: currentConstitutionalBootId,
      monotonicNowNs: process.hrtime.bigint,
    });
    // This is the serving reader alone: no watchdog, recovery socket, or
    // controller is involved. The public router consequently escalates.
    expect(readConstitutionalRouteDatabase(path, clock(at - 1))).toBe(candidate);
    expect(routingTarget("summarize", undefined, path)).toBe("qwen");
    expect(() => readConstitutionalRouteDatabase(path, clock(at))).toThrow(ConstitutionalRouteBlockedError);
    expect(() => readConstitutionalRouteDatabase(path, clock(at + 1))).toThrow(ConstitutionalRouteBlockedError);
    // A reboot cannot trust a potentially rolled-back RTC to extend candidate
    // traffic beyond its original monotonic budget.
    expect(() => readConstitutionalRouteDatabase(path, {
      wallNowMs: () => at - 1,
      bootId: () => "new-boot-with-rolled-back-rtc",
    })).toThrow(ConstitutionalRouteBlockedError);

    // A fresh process/database handle sees exactly the same expired state.
    new ConstitutionalRouteDatabase(path);
    expect(() => readConstitutionalRouteDatabase(path, clock(at + 1))).toThrow(ConstitutionalRouteBlockedError);

    // An old fence cannot stretch the deadline after a successor owns the
    // resource; it cannot turn an expired candidate back into local traffic.
    lease.release();
    const successor = route.acquireWriterLease();
    const successorFence = { epoch: successor.epoch, token: successor.token };
    expect(route.compareAndSwap(candidate, candidate, fence, { ...candidateDeadline, notAfter: "2030-07-26T02:10:00Z" })).toBe(false);
    expect(route.clearCandidateDeadline(candidateDeadline, successorFence)).toBe(true);
    expect(readConstitutionalRouteDatabase(path, clock(at + 1))).toBe(candidate);

    // Revert atomically removes the deadline with the exact baseline restore.
    expect(route.compareAndSwap(candidate, candidate, successorFence, candidateDeadline)).toBe(true);
    expect(route.restoreExact(digest(candidate), baseline, successorFence)).toBe(true);
    expect(readConstitutionalRouteDatabase(path, clock(at + 1))).toBe(baseline);
    successor.release();
  });
});
