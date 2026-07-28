import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConstitutionalFencedLease,
  ConstitutionalLeaseBusyError,
  ConstitutionalLeaseStaleError,
  readConstitutionalResource,
  readConstitutionalResourceReadonly,
} from "../src/homeserver/constitutional-fenced-lease.js";

describe("constitutional expiring fenced lease", () => {
  it("advances a monotonic epoch after expiry and permanently rejects the stale token", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-lease-")), "lease.db");
    let now = 1_000_000_000n;
    const options = { durationMs: 100, monotonicNowNs: () => now, bootId: "boot-a" };
    const first = ConstitutionalFencedLease.acquire(path, options);
    first.writeResource("journal", "epoch-1");
    expect(first.epoch).toBe(1);
    expect(() => ConstitutionalFencedLease.acquire(path, options)).toThrow(ConstitutionalLeaseBusyError);

    now += 101_000_000n;
    const second = ConstitutionalFencedLease.acquire(path, options);
    expect(second.epoch).toBe(2);
    expect(second.token).not.toBe(first.token);
    expect(() => first.assertCurrentAndRenew()).toThrow(ConstitutionalLeaseStaleError);
    second.writeResource("journal", "epoch-2");
    expect(() => first.writeResource("journal", "stale-overwrite")).toThrow(ConstitutionalLeaseStaleError);
    expect(readConstitutionalResource(path, "journal")).toBe("epoch-2");

    first.release();
    expect(() => second.transition(() => "new-holder-write")).not.toThrow();
    second.release();
  });

  it("reclaims a fresh-looking pre-reboot row instead of comparing reset monotonic time or reused PIDs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-lease-")), "lease.db");
    const before = ConstitutionalFencedLease.acquire(path, {
      durationMs: 60_000,
      monotonicNowNs: () => 9_000_000_000n,
      bootId: "boot-before",
    });
    const after = ConstitutionalFencedLease.acquire(path, {
      durationMs: 60_000,
      monotonicNowNs: () => 1_000_000n,
      bootId: "boot-after",
    });
    expect(after.epoch).toBe(before.epoch + 1);
    before.release();
    after.release();
  });

  it("lets recovery read state without opening a writable database handle", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-readonly-")), "state.db");
    const lease = ConstitutionalFencedLease.acquire(path);
    lease.writeResource("journal", "prepared");
    lease.release();
    const before = statSync(path);
    expect(readConstitutionalResourceReadonly(path, "journal")).toBe("prepared");
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
