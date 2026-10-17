import { describe, expect, it } from "vitest";

import {
  ModelFailureBackoff,
  type BackendFailureKind,
} from "../src/homeserver/model-failure-backoff.js";

const FAILURE: BackendFailureKind = "upstream_http_error";

describe("ModelFailureBackoff", () => {
  it("opens a fixed 30 second backoff after three backend failures", () => {
    let now = Date.UTC(2026, 0, 1);
    const backoff = new ModelFailureBackoff(["model-a"], () => now);

    backoff.recordFailure("model-a", FAILURE);
    now += 1_000;
    backoff.recordFailure("model-a", "upstream_unavailable");
    now += 1_000;
    backoff.recordFailure("model-a", "upstream_timeout");

    expect(backoff.observe("model-a")).toEqual({
      code: "model_temporarily_unavailable",
      retry_after_seconds: 30,
      unavailable_until: new Date(now + 30_000).toISOString(),
    });
  });

  it("keeps model failure sequences separate", () => {
    const backoff = new ModelFailureBackoff(["model-a", "model-b"], () => 10_000);
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);

    backoff.recordFailure("model-b", "model_load_failed");
    backoff.recordFailure("model-b", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();
    expect(backoff.observe("model-b")).toBeNull();

    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")?.retry_after_seconds).toBe(30);
    expect(backoff.observe("model-b")).toBeNull();
  });

  it("starts a new sequence when prior failures are outside the rolling window", () => {
    let now = 5_000;
    const backoff = new ModelFailureBackoff(["model-a"], () => now);
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);
    now += 60_001;
    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();

    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();
    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")?.retry_after_seconds).toBe(30);
  });

  it("expires without extending cooldown and treats the next failure as first", () => {
    let now = 1_000;
    const backoff = new ModelFailureBackoff(["model-a"], () => now);
    for (let index = 0; index < 3; index += 1) backoff.recordFailure("model-a", FAILURE);
    const first = backoff.observe("model-a");

    now += 10_500;
    const middle = backoff.observe("model-a");
    expect(middle?.retry_after_seconds).toBe(20);
    expect(middle?.unavailable_until).toBe(first?.unavailable_until);
    expect(backoff.observe("model-a")).toEqual(middle);

    now += 19_500;
    expect(backoff.observe("model-a")).toBeNull();
    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();
  });

  it("resets the sequence on success", () => {
    const backoff = new ModelFailureBackoff(["model-a"], () => 1_000);
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordSuccess("model-a");
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();

    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")?.retry_after_seconds).toBe(30);
  });

  it("ignores refusals and returns only the documented safe fields", () => {
    let now = 10_000;
    const backoff = new ModelFailureBackoff(["model-a"], () => now);
    for (let index = 0; index < 3; index += 1) backoff.recordFailure("model-a", FAILURE);
    const opened = backoff.observe("model-a");

    now += 1_000;
    expect(backoff.observe("model-a")).toEqual({
      code: "model_temporarily_unavailable",
      retry_after_seconds: 29,
      unavailable_until: opened?.unavailable_until,
    });
    expect(Object.keys(backoff.observe("model-a") ?? {}).sort()).toEqual([
      "code",
      "retry_after_seconds",
      "unavailable_until",
    ]);
  });

  it("does not allocate or report state for unknown or malformed model IDs", () => {
    let now = 0;
    const backoff = new ModelFailureBackoff(["model-a", "", "  bad id", "bad\nmodel"], () => now);
    for (let index = 0; index < 5; index += 1) backoff.recordFailure("unknown-model", FAILURE);
    backoff.recordFailure("", FAILURE);
    backoff.recordFailure("  bad id", FAILURE);
    backoff.recordFailure("bad\nmodel", FAILURE);

    expect(backoff.observe("unknown-model")).toBeNull();
    expect(backoff.observe(42)).toBeNull();
    expect(backoff.observe(null)).toBeNull();
    expect(backoff.observe("model-a")).toBeNull();

    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);
    now += 60_001;
    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();
  });

  it("fails safely when the injected clock is invalid", () => {
    const backoff = new ModelFailureBackoff(["model-a"], () => Number.NaN);
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);
    backoff.recordFailure("model-a", FAILURE);
    expect(backoff.observe("model-a")).toBeNull();
  });
});
