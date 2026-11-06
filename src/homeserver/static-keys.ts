/**
 * Legacy static bearer credentials (INFER-152).
 *
 * `HOMESERVER_ADMIN_API_KEYS`, `HOMESERVER_API_KEYS` and `HOMESERVER_MONITOR_API_KEYS` carry no
 * expiry, no revocation and no per-key identity. This module only ever sees their *presence and
 * count*: it never returns, hashes, fingerprints or logs a configured value. Operators use it to
 * inventory the lists and to switch them off with `HOMESERVER_DISABLE_STATIC_KEYS` once every
 * consumer has migrated to a minted, scoped, expiring key.
 */

export type StaticKeyList = "admin" | "user" | "monitor";

export const STATIC_KEY_LISTS: readonly StaticKeyList[] = Object.freeze(["admin", "user", "monitor"]);

/** Environment variable that configures each list. Names only; never values. */
export const STATIC_KEY_ENV: Readonly<Record<StaticKeyList, string>> = Object.freeze({
  admin: "HOMESERVER_ADMIN_API_KEYS",
  user: "HOMESERVER_API_KEYS",
  monitor: "HOMESERVER_MONITOR_API_KEYS",
});

export const STATIC_KEY_SWITCH_ENV = "HOMESERVER_DISABLE_STATIC_KEYS";

export interface StaticKeyCounts {
  admin: number;
  user: number;
  monitor: number;
  total: number;
}

export type StaticKeyKillSwitch = Record<StaticKeyList, boolean>;

/** Thrown for a malformed switch value. The message deliberately never echoes the value. */
export class InvalidStaticKeySwitchError extends Error {
  constructor() {
    super(
      `${STATIC_KEY_SWITCH_ENV} must be unset, 'off', 'on', or a comma-separated subset of ` +
      `${STATIC_KEY_LISTS.join(",")}`
    );
    this.name = "InvalidStaticKeySwitchError";
  }
}

/** Same splitting rule as the config loader (comma list, trimmed, empties dropped). */
function countList(raw: string | undefined): number {
  if (!raw) return 0;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).length;
}

/** Counts of configured static values per list. Values are counted and immediately discarded. */
export function countStaticCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env
): StaticKeyCounts {
  const admin = countList(env[STATIC_KEY_ENV.admin]);
  const user = countList(env[STATIC_KEY_ENV.user]);
  const monitor = countList(env[STATIC_KEY_ENV.monitor]);
  return { admin, user, monitor, total: admin + user + monitor };
}

/**
 * Strict parser. Unset/empty/`off` → nothing disabled (existing behaviour); `on` → all lists;
 * otherwise a comma-separated subset of `admin,user,monitor`. Anything else (unknown token,
 * empty element, mixing `on`/`off` with a list) throws without echoing the input.
 */
export function parseStaticKeyKillSwitch(raw: string | undefined): StaticKeyKillSwitch {
  const none: StaticKeyKillSwitch = { admin: false, user: false, monitor: false };
  if (raw === undefined) return none;
  const value = raw.trim();
  if (value === "" || value === "off") return none;
  if (value === "on") return { admin: true, user: true, monitor: true };
  const out: StaticKeyKillSwitch = { ...none };
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name !== "admin" && name !== "user" && name !== "monitor") {
      throw new InvalidStaticKeySwitchError();
    }
    out[name] = true;
  }
  return out;
}

export function disabledStaticLists(sw: StaticKeyKillSwitch): StaticKeyList[] {
  return STATIC_KEY_LISTS.filter((list) => sw[list]);
}

/** Counts of static credentials that can still authenticate once the switch is applied. */
export function effectiveStaticCounts(counts: StaticKeyCounts, sw: StaticKeyKillSwitch): StaticKeyCounts {
  const admin = sw.admin ? 0 : counts.admin;
  const user = sw.user ? 0 : counts.user;
  const monitor = sw.monitor ? 0 : counts.monitor;
  return { admin, user, monitor, total: admin + user + monitor };
}

/** One content-free startup line: switch state and the counts it is ignoring (or accepting). */
export function staticKeyStartupLine(counts: StaticKeyCounts, sw: StaticKeyKillSwitch): string {
  const disabled = disabledStaticLists(sw);
  const configured = `admin=${counts.admin} user=${counts.user} monitor=${counts.monitor}`;
  if (disabled.length === 0) {
    return `[auth] static-key kill switch ${STATIC_KEY_SWITCH_ENV}: off; static credentials accepted (${configured})`;
  }
  const ignored = effectiveStaticCounts(counts, { admin: false, user: false, monitor: false });
  const ignoring = disabled.map((list) => `${list}=${ignored[list]}`).join(" ");
  return `[auth] static-key kill switch ${STATIC_KEY_SWITCH_ENV}: on (${disabled.join(",")}); ignoring ${ignoring}; configured ${configured}`;
}

/**
 * Number of distinct configured values that appear in more than one list. Compared in memory
 * only; neither the values nor any digest of them leaves this function. A shared value is
 * dangerous with a per-list kill switch, so the gateway treats it as disabled when ANY list that
 * contains it is disabled.
 */
export function countOverlappingStaticValues(lists: readonly (readonly string[])[]): number {
  const seenIn = new Map<string, number>();
  for (const list of lists) {
    for (const value of new Set(list)) seenIn.set(value, (seenIn.get(value) ?? 0) + 1);
  }
  let shared = 0;
  for (const n of seenIn.values()) if (n > 1) shared += 1;
  return shared;
}
