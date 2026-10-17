import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeBoundBackendActivity,
  validateBoundBackendTargets,
} from "../src/homeserver/bound-backend-activity.js";
import type { RuntimeProcessEvidence } from "../src/homeserver/runtime-process-evidence.js";
import { observeRuntimeProcess, type RuntimeProcessReader } from "../src/homeserver/runtime-process-evidence.js";

const target = { id: "runtime-a", url: "http://127.0.0.1:8081/metrics", pid: 1234 };
const metrics = "# TYPE llamacpp:requests_processing gauge\nllamacpp:requests_processing 2\n# TYPE llamacpp:requests_deferred gauge\nllamacpp:requests_deferred 1\n";
const identity = "a".repeat(64);
const host = "b".repeat(64);
const evidence = (overrides: Partial<RuntimeProcessEvidence> = {}): RuntimeProcessEvidence => ({
  state: "observed", reason: "sampled", identitySha256: identity, hostBootIdSha256: host, ...overrides,
});
const fetcher = vi.fn(async () => new Response(metrics)) as unknown as typeof fetch;

describe("bound backend activity observations", () => {
  beforeEach(() => { (fetcher as ReturnType<typeof vi.fn>).mockClear(); });
  it("samples before and after metrics and labels stable unpinned evidence observed", async () => {
    const observeProcess = vi.fn(async () => evidence());
    const result = await observeBoundBackendActivity([target], { observeProcess, fetch: fetcher });
    expect(result).toMatchObject({ coverage: "unknown", scope: "configured-runtime-schedulers", targets: [{
      id: "runtime-a", state: "observed", active: 2, queued: 1, reason: "ok",
      process: { label: "observed", before: evidence(), after: evidence() },
    }] });
    expect(observeProcess).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires a pinned identity before fetching and labels a matched pin", async () => {
    const observeProcess = vi.fn(async () => evidence());
    const result = await observeBoundBackendActivity([{ ...target, expectedIdentitySha256: identity }], {
      observeProcess, fetch: fetcher, expectedHostBootIdSha256: host,
    });
    expect(result.targets[0]).toMatchObject({ state: "observed", process: { label: "matched" } });
    expect(observeProcess).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on pin mismatch without a metrics fetch", async () => {
    const observeProcess = vi.fn(async () => evidence());
    const result = await observeBoundBackendActivity([{ ...target, expectedIdentitySha256: "c".repeat(64) }], {
      observeProcess, fetch: fetcher,
    });
    expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null, reason: "identity-mismatch",
      process: { label: "unknown", reason: "identity-mismatch", after: null } });
    expect(observeProcess).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the process changes between samples", async () => {
    const observeProcess = vi.fn()
      .mockResolvedValueOnce(evidence())
      .mockResolvedValueOnce(evidence({ identitySha256: "c".repeat(64) }));
    const result = await observeBoundBackendActivity([target], { observeProcess, fetch: fetcher });
    expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null, reason: "process-changed",
      process: { label: "unknown", reason: "process-changed", before: evidence(), after: evidence({ identitySha256: "c".repeat(64) }) } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not fetch after unknown process evidence", async () => {
    const observeProcess = vi.fn(async () => evidence({ state: "unknown", reason: "unsupported-platform", identitySha256: null, hostBootIdSha256: null }));
    const result = await observeBoundBackendActivity([target], { observeProcess, fetch: fetcher });
    expect(result.targets[0]).toMatchObject({ state: "unknown", reason: "unsupported-platform", process: { after: null, label: "unknown" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates safe PIDs and lowercase digests while allowing duplicate PIDs", () => {
    expect(validateBoundBackendTargets([{ ...target, id: "a", url: "http://127.0.0.1:8081/metrics" }, { ...target, id: "b", url: "http://127.0.0.1:8082/metrics" }])).toHaveLength(2);
    for (const bad of [
      { ...target, pid: 0 }, { ...target, pid: 2_147_483_648 }, { ...target, pid: 1.5 },
      { ...target, expectedIdentitySha256: "A".repeat(64) }, { ...target, expectedIdentitySha256: "a".repeat(63) },
      { ...target, token: "private" },
    ]) expect(() => validateBoundBackendTargets([bad])).toThrow("invalid bound backend targets");
  });

  it("matches a host-only pin without claiming a matched runtime pin", async () => {
    const result = await observeBoundBackendActivity([target], { observeProcess: async () => evidence(), fetch: fetcher, expectedHostBootIdSha256: host });
    expect(result.targets[0].process).toMatchObject({ label: "observed", hostPin: "matched" });
  });

  it("blocks a mismatched host before fetching", async () => {
    const result = await observeBoundBackendActivity([target], { observeProcess: async () => evidence(), fetch: fetcher, expectedHostBootIdSha256: "c".repeat(64) });
    expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null, reason: "host-mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discards counts on a post-fetch read failure or host change", async () => {
    for (const after of [evidence({ hostBootIdSha256: "c".repeat(64) }), evidence({ state: "unknown", reason: "read-failed", identitySha256: null, hostBootIdSha256: null })]) {
      const observeProcess = vi.fn().mockResolvedValueOnce(evidence()).mockResolvedValueOnce(after);
      const result = await observeBoundBackendActivity([target], { observeProcess, fetch: fetcher });
      expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null });
    }
  });

  it("normalizes rejected and malformed observer results without echoing input", async () => {
    const malformed = evidence({ identitySha256: "private" });
    for (const observeProcess of [async () => malformed, async () => { throw new Error("private"); }]) {
      const result = await observeBoundBackendActivity([target], { observeProcess, fetch: fetcher });
      expect(result.targets[0].reason).toBe("read-failed");
      expect(JSON.stringify(result)).not.toContain("private");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds a stalled first observation and never starts later work after it resolves", async () => {
    let release!: (value: RuntimeProcessEvidence) => void;
    const observeProcess = vi.fn(() => new Promise<RuntimeProcessEvidence>(resolve => { release = resolve; }));
    const result = await observeBoundBackendActivity([target, { ...target, id: "second", url: "http://127.0.0.1:8082/metrics" }], { observeProcess, fetch: fetcher, timeoutMs: 10 });
    expect(result.targets.every(value => value.reason === "timeout" && value.active === null)).toBe(true);
    release(evidence());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(observeProcess).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discards counts if the post-fetch observer stalls", async () => {
    const observeProcess = vi.fn().mockResolvedValueOnce(evidence()).mockImplementationOnce(() => new Promise(() => {}));
    const result = await observeBoundBackendActivity([target], { observeProcess, fetch: fetcher, timeoutMs: 20 });
    expect(result.targets[0]).toMatchObject({ state: "unknown", active: null, queued: null, reason: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels native follow-on reads even if its nested deadline has extra slack", async () => {
    let release!: (value: string) => void;
    let child!: Promise<RuntimeProcessEvidence>;
    const readText = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const reader: RuntimeProcessReader = {
      platform: "linux", endianness: "LE", readText,
      readLink: async () => "", executableIdentity: async () => "", descriptorNames: async () => [],
    };
    const result = await observeBoundBackendActivity([target], { timeoutMs: 10, fetch: fetcher,
      observeProcess: (value, opts) => {
        // Magnify relative-deadline slack to make cancellation deterministic.
        child = observeRuntimeProcess(value, { ...opts, timeoutMs: 100, reader });
        return child;
      },
    });
    expect(result.targets[0].reason).toBe("timeout");
    release("12345678-1234-1234-1234-123456789abc");
    expect((await child).reason).toBe("timeout");
    expect(readText).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
