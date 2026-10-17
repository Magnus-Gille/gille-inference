import { describe, expect, it } from "vitest";
import { AudioUploadAdmission } from "../src/homeserver/audio-upload-admission.js";

describe("AudioUploadAdmission", () => {
  it("allows at most one guest and preserves the second process slot for an owner", () => {
    const admission = new AudioUploadAdmission();
    const guest = admission.acquire("guest-a", "guest", 2);
    expect(guest).not.toBeNull();
    expect(admission.acquire("guest-b", "guest", 2)).toBeNull();
    const owner = admission.acquire("owner-a", "owner", 2);
    expect(owner).not.toBeNull();
    expect(admission.acquire("owner-b", "owner", 2)).toBeNull();
    guest?.();
    const guestAgain = admission.acquire("guest-b", "guest", 2);
    expect(guestAgain).not.toBeNull();
    guestAgain?.();
    owner?.();
  });

  it("enforces the per-alias minimum of two and the caller's lower cap", () => {
    const admission = new AudioUploadAdmission();
    const first = admission.acquire("owner-a", "owner", 4);
    const second = admission.acquire("owner-a", "owner", 4);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(admission.acquire("owner-a", "owner", 4)).toBeNull();
    first?.();
    second?.();

    const single = admission.acquire("owner-b", "owner", 1);
    expect(single).not.toBeNull();
    expect(admission.acquire("owner-b", "owner", 1)).toBeNull();
    single?.();
  });

  it("fails closed for invalid aliases or parallel limits and releases idempotently", () => {
    const admission = new AudioUploadAdmission();
    expect(admission.acquire("bad", "owner", Number.NaN)).toBeNull();
    expect(admission.acquire("bad", "owner", -1)).toBeNull();
    expect(admission.acquire("", "owner", 1)).toBeNull();
    const release = admission.acquire("owner-a", "owner", 1);
    expect(release).not.toBeNull();
    release?.();
    release?.();
    expect(admission.acquire("owner-b", "owner", 1)).not.toBeNull();
  });
});
