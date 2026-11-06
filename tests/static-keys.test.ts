import { describe, expect, it } from "vitest";
import {
  InvalidStaticKeySwitchError,
  countStaticCredentials,
  effectiveStaticCounts,
  parseStaticKeyKillSwitch,
  staticKeyStartupLine,
} from "../src/homeserver/static-keys.js";

describe("static credential counts (INFER-152)", () => {
  it("counts configured values per list with the config loader's splitting rule", () => {
    const counts = countStaticCredentials({
      HOMESERVER_ADMIN_API_KEYS: "a1, a2 ,,",
      HOMESERVER_API_KEYS: "u1",
      HOMESERVER_MONITOR_API_KEYS: undefined,
    });
    expect(counts).toEqual({ admin: 2, user: 1, monitor: 0, total: 3 });
  });

  it("never returns a configured value", () => {
    const counts = countStaticCredentials({ HOMESERVER_ADMIN_API_KEYS: "planted-admin-secret" });
    expect(JSON.stringify(counts)).not.toContain("planted-admin-secret");
  });
});

describe("HOMESERVER_DISABLE_STATIC_KEYS parser (INFER-152)", () => {
  const none = { admin: false, user: false, monitor: false };

  it("defaults to off for unset, empty and 'off'", () => {
    expect(parseStaticKeyKillSwitch(undefined)).toEqual(none);
    expect(parseStaticKeyKillSwitch("")).toEqual(none);
    expect(parseStaticKeyKillSwitch("  off ")).toEqual(none);
  });

  it("'on' disables every list and a subset disables only those lists", () => {
    expect(parseStaticKeyKillSwitch("on")).toEqual({ admin: true, user: true, monitor: true });
    expect(parseStaticKeyKillSwitch("admin, monitor")).toEqual({ admin: true, user: false, monitor: true });
  });

  it.each(["true", "1", "ADMIN", "admin,", "admin,bogus-secret-value", "on,admin", "off,user", ","])(
    "rejects %j without echoing it",
    (raw) => {
      let caught: unknown;
      try {
        parseStaticKeyKillSwitch(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidStaticKeySwitchError);
      const message = (caught as Error).message;
      expect(message).toContain("HOMESERVER_DISABLE_STATIC_KEYS");
      expect(message).not.toContain("bogus-secret-value");
      // The message lists the legal names; the rejected input itself is never quoted.
      expect(message).not.toContain(`"${raw}"`);
      expect(message).not.toContain(`'${raw}'`);
    }
  );
});

describe("static-key startup line (INFER-152)", () => {
  const counts = { admin: 2, user: 1, monitor: 0, total: 3 };

  it("states off and the counts that are accepted", () => {
    const line = staticKeyStartupLine(counts, parseStaticKeyKillSwitch(undefined));
    expect(line).toContain("off");
    expect(line).toContain("admin=2 user=1 monitor=0");
  });

  it("states on and the counts it is ignoring", () => {
    const line = staticKeyStartupLine(counts, parseStaticKeyKillSwitch("admin,user"));
    expect(line).toContain("on (admin,user)");
    expect(line).toContain("ignoring admin=2 user=1");
  });

  it("effective counts drop disabled lists only", () => {
    expect(effectiveStaticCounts(counts, parseStaticKeyKillSwitch("admin"))).toEqual({
      admin: 0, user: 1, monitor: 0, total: 1,
    });
  });
});
