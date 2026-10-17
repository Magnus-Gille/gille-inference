import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeGpuLeaseMutex } from "../src/homeserver/gpu-lease-observation.js";

// Keep the production API unchanged while giving the race test a deterministic seam. Vitest
// cannot spy on the non-configurable ESM namespace export directly, so wrap only `open` here.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const NOW = 1_700_000_000_000;
const STALE_MS = 30_000;
const HOLDER_ID = "00000000-0000-4000-8000-000000000001";
const QUEUE_ID = "00000000-0000-4000-8000-000000000002";

function owner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: HOLDER_ID,
    pid: 4321,
    heartbeatAt: NOW - 1_000,
    host: "m5-test",
    ...overrides,
  };
}

async function writeOwner(dir: string, value: unknown): Promise<void> {
  await mkdir(join(dir, ".holder"), { recursive: true });
  await writeFile(join(dir, ".holder", "owner.json"), JSON.stringify(value));
}

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];

  async function visit(current: string, relative = ""): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = join(relative, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`${name}/`);
        await visit(path, name);
      } else if (entry.isSymbolicLink()) {
        snapshot.push(`${name}->${await readlink(path)}`);
      } else {
        snapshot.push(`${name}:${await readFile(path, "utf8")}`);
      }
    }
  }

  await visit(root);
  return snapshot;
}

function expectEnvelope(
  result: Awaited<ReturnType<typeof observeGpuLeaseMutex>>,
  expected: {
    state: "absent" | "occupied" | "unknown";
    held: boolean | null;
    ownerState: "fresh" | "stale" | "missing" | "invalid" | "future" | "unknown";
    owner?: { id: string; pid: number; heartbeatAt: number } | null;
  },
): void {
  expect(result.state).toBe(expected.state);
  expect(result.held).toBe(expected.held);
  expect(result.ownerState).toBe(expected.ownerState);
  expect(result.owner ?? null).toEqual(expected.owner ?? null);
  expect(result.observedAt).toBe(new Date(NOW).toISOString());
  expect(result.source).toBe("gpu-mkdir-mutex-v1");
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.length).toBeGreaterThan(0);
}

describe("observeGpuLeaseMutex", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpu-lease-observation-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("bounds a stalled filesystem read and reports unknown", async () => {
    vi.mocked(fsPromises.lstat).mockImplementationOnce(() => new Promise(() => {}));
    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, timeoutMs: 10 });
    expectEnvelope(result, { state: "unknown", held: null, ownerState: "unknown" });
    expect(result.reason).toBe("filesystem-timeout");
  });

  it("reports an existing empty lease directory as absent", async () => {
    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "absent", held: false, ownerState: "unknown" });
  });

  it("fails closed when the lease root is missing", async () => {
    const missing = join(dir, "does-not-exist");
    const result = await observeGpuLeaseMutex(missing, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "unknown", held: null, ownerState: "unknown" });
  });

  it("treats a holder directory without an owner marker as occupied with a missing owner", async () => {
    await mkdir(join(dir, ".holder"));

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "occupied", held: true, ownerState: "missing" });
  });

  it("maps a valid fresh owner marker to an occupied lease", async () => {
    await writeOwner(dir, owner());

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, {
      state: "occupied",
      held: true,
      ownerState: "fresh",
      owner: { id: HOLDER_ID, pid: 4321, heartbeatAt: NOW - 1_000 },
    });
  });

  it("keeps a stale owner occupied instead of reclaiming the mutex", async () => {
    await writeOwner(dir, owner({ heartbeatAt: NOW - STALE_MS - 1 }));

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, {
      state: "occupied",
      held: true,
      ownerState: "stale",
      owner: { id: HOLDER_ID, pid: 4321, heartbeatAt: NOW - STALE_MS - 1 },
    });
  });

  it("keeps an owner with a future heartbeat occupied and marks it future", async () => {
    await writeOwner(dir, owner({ heartbeatAt: NOW + 1 }));

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, {
      state: "occupied",
      held: true,
      ownerState: "future",
      owner: { id: HOLDER_ID, pid: 4321, heartbeatAt: NOW + 1 },
    });
  });

  it("keeps a malformed owner marker occupied and marks its owner invalid", async () => {
    await writeOwner(dir, { id: "not-a-uuid", pid: "4321", heartbeatAt: "now", host: 7 });

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "occupied", held: true, ownerState: "invalid" });
  });

  it("fails closed when the holder entry is a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "gpu-lease-observation-outside-"));
    await symlink(outside, join(dir, ".holder"));

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "unknown", held: null, ownerState: "unknown" });
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects an owner symlink without reading its valid target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "gpu-lease-observation-owner-target-"));
    await mkdir(join(dir, ".holder"));
    const target = join(outside, "owner.json");
    await writeFile(target, JSON.stringify(owner()));
    await symlink(target, join(dir, ".holder", "owner.json"));

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "occupied", held: true, ownerState: "invalid" });
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects an oversized owner marker as invalid", async () => {
    await mkdir(join(dir, ".holder"));
    await writeFile(
      join(dir, ".holder", "owner.json"),
      JSON.stringify({ ...owner(), padding: "x".repeat(512 * 1024) }),
    );

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "occupied", held: true, ownerState: "invalid" });
  });

  it("uses the mutex owner even when the queue head names another process", async () => {
    await writeOwner(dir, owner());
    await writeFile(
      join(dir, `${QUEUE_ID}.json`),
      JSON.stringify({ id: QUEUE_ID, pid: 9876, seq: 1, heartbeatAt: NOW, host: "queue-head" }),
    );

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, {
      state: "occupied",
      held: true,
      ownerState: "fresh",
      owner: { id: HOLDER_ID, pid: 4321, heartbeatAt: NOW - 1_000 },
    });
  });

  it("does not reclaim or otherwise mutate stale mutex evidence", async () => {
    await writeOwner(dir, owner({ heartbeatAt: NOW - STALE_MS - 1 }));
    await writeFile(join(dir, `${QUEUE_ID}.json`), JSON.stringify({ id: QUEUE_ID, heartbeatAt: NOW - 1 }));
    const before = await snapshotTree(dir);

    await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    await expect(snapshotTree(dir)).resolves.toEqual(before);
  });

  it("reports unknown when the holder directory is replaced during the owner read", async () => {
    await writeOwner(dir, owner());
    const replacement = await mkdtemp(join(tmpdir(), "gpu-lease-observation-replacement-"));
    const openMock = vi.mocked(fsPromises.open);
    openMock.mockImplementationOnce(async (..._args: any[]) => {
      await rm(join(dir, ".holder"), { recursive: true, force: true });
      await symlink(replacement, join(dir, ".holder"));
      throw Object.assign(new Error("simulated directory replacement"), { code: "ENOENT" });
    });

    const result = await observeGpuLeaseMutex(dir, { now: () => NOW, staleMs: STALE_MS });

    expectEnvelope(result, { state: "unknown", held: null, ownerState: "unknown" });
    expect(openMock).toHaveBeenCalled();
    await rm(replacement, { recursive: true, force: true });
  });
});
