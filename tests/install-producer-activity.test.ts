import { describe, expect, it } from "vitest";
import {
  installProducerIdentitySchema,
  installProducerSnapshotSchema,
  InstallProducerActivity,
} from "../src/homeserver/install-producer-activity.js";

const identity = {
  producerId: "gateway_runtime-1",
  instanceSha256: "a".repeat(64),
  buildSha256: "b".repeat(64),
  configSha256: "c".repeat(64),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("install producer activity", () => {
  it("validates the strict identity and snapshot schemas", () => {
    expect(installProducerIdentitySchema.parse(identity)).toEqual(identity);
    expect(() => installProducerIdentitySchema.parse({ ...identity, extra: true })).toThrow();
    expect(() => installProducerIdentitySchema.parse({ ...identity, producerId: "bad id" })).toThrow();
    expect(() => installProducerIdentitySchema.parse({ ...identity, buildSha256: "A".repeat(64) })).toThrow();

    const snapshot = { ...identity, active: 1, queued: 0, loading: null, workStarted: 3 };
    expect(installProducerSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => installProducerSnapshotSchema.parse({ ...snapshot, extra: true })).toThrow();
    expect(() => installProducerSnapshotSchema.parse({ ...snapshot, active: -1 })).toThrow();
    expect(() => installProducerSnapshotSchema.parse({ ...snapshot, workStarted: 1.5 })).toThrow();
  });

  it("tracks concurrent handles and a queued to active lifecycle", () => {
    const activity = new InstallProducerActivity(identity);
    const queued = activity.begin("queued");
    const active = activity.begin("active");
    expect(activity.snapshot()).toMatchObject({ active: 1, queued: 1, loading: 0, workStarted: 2 });

    queued.transition("active");
    expect(activity.snapshot()).toMatchObject({ active: 2, queued: 0, loading: 0, workStarted: 2 });
    queued.transition("loading");
    expect(activity.snapshot()).toMatchObject({ active: 1, queued: 0, loading: 1, workStarted: 2 });
    queued.finish();
    queued.finish();
    expect(activity.snapshot()).toMatchObject({ active: 1, queued: 0, loading: 0, workStarted: 2 });
    active.finish();
    expect(activity.snapshot()).toMatchObject({ active: 0, queued: 0, loading: 0, workStarted: 2 });
  });

  it("keeps a request counted through client abort and until its promise settles", async () => {
    const activity = new InstallProducerActivity(identity);
    const pending = deferred<string>();
    const controller = new AbortController();
    const tracked = activity.track("queued", async () => {
      await pending.promise;
      return "settled";
    });
    controller.abort();
    expect(activity.snapshot()).toMatchObject({ queued: 1, active: 0, loading: 0, workStarted: 1 });
    pending.resolve("done");
    await expect(tracked).resolves.toBe("settled");
    expect(activity.snapshot()).toMatchObject({ queued: 0, active: 0, loading: 0, workStarted: 1 });

    await expect(activity.track("active", async () => {
      throw new Error("handler failed");
    })).rejects.toThrow("handler failed");
    expect(activity.snapshot()).toMatchObject({ active: 0, workStarted: 2 });
  });

  it("leaves a monotonic start sequence after brief completed work", async () => {
    const activity = new InstallProducerActivity(identity);
    await expect(activity.track("active", async () => "ok")).resolves.toBe("ok");
    expect(activity.snapshot().workStarted).toBe(1);
    const handle = activity.begin("active");
    expect(activity.snapshot().workStarted).toBe(2);
    handle.finish();
    expect(activity.snapshot().workStarted).toBe(2);
  });

  it("latches unknown on lowered sequence overflow and rejects further work", () => {
    const activity = new InstallProducerActivity(identity, { maxSequence: 1 });
    const first = activity.begin("active");
    first.finish();
    expect(() => activity.begin("queued")).toThrow("work start sequence overflow");
    expect(activity.snapshot()).toEqual({ ...identity, active: null, queued: null, loading: null, workStarted: null });
    expect(() => activity.begin("active")).toThrow("producer activity is unknown");
  });

  it("latches unknown on tracked-work capacity overflow", () => {
    const activity = new InstallProducerActivity(identity, { maxTrackedWork: 1 });
    const first = activity.begin("active");
    expect(() => activity.begin("queued")).toThrow("tracked work capacity exceeded");
    expect(activity.snapshot()).toEqual({ ...identity, active: null, queued: null, loading: null, workStarted: null });
    first.finish();
    expect(activity.snapshot().active).toBeNull();
  });

  it("latches unknown on invalid transitions and never fabricates healthy state", () => {
    const activity = new InstallProducerActivity(identity);
    const handle = activity.begin("active");
    handle.finish();
    expect(() => handle.transition("queued")).toThrow("invalid producer activity transition");
    expect(activity.snapshot()).toEqual({ ...identity, active: null, queued: null, loading: null, workStarted: null });
    expect(() => activity.begin("loading")).toThrow("producer activity is unknown");
  });

  it("preserves actual work when accounting capacity fails or is already unknown", async () => {
    const activity = new InstallProducerActivity(identity, { maxTrackedWork: 1 });
    const first = activity.begin("active");
    await expect(activity.track("active", async () => "inference-result")).resolves.toBe("inference-result");
    expect(activity.snapshot().active).toBeNull();
    await expect(activity.track("active", async () => "another-result")).resolves.toBe("another-result");
    const original = new Error("actual producer failure");
    await expect(activity.track("active", async () => { throw original; })).rejects.toBe(original);
    first.finish();
    expect(activity.snapshot().workStarted).toBeNull();
  });

  it("returns detached snapshots", () => {
    const activity = new InstallProducerActivity(identity);
    const first = activity.snapshot();
    first.producerId = "mutated";
    first.active = 99;
    const second = activity.snapshot();
    expect(second).toEqual({ ...identity, active: 0, queued: 0, loading: 0, workStarted: 0 });
  });

  it("rejects invalid constructors and ceilings that exceed defaults", () => {
    expect(() => new InstallProducerActivity({ ...identity, producerId: "" })).toThrow("invalid producer identity");
    expect(() => new InstallProducerActivity(identity, { maxTrackedWork: 0 })).toThrow("invalid producer activity options");
    expect(() => new InstallProducerActivity(identity, { maxTrackedWork: 4097 })).toThrow("invalid producer activity options");
    expect(() => new InstallProducerActivity(identity, { maxSequence: Infinity })).toThrow("invalid producer activity options");
    expect(() => new InstallProducerActivity(identity, { maxSequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow("invalid producer activity options");
  });
});
