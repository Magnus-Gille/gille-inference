/**
 * Tests for the `keys invites` CLI subcommand:
 *   1. listInvites() data integrity: create 2 invites, redeem 1, assert the public
 *      list reflects one redeemed (redeemedKeyAlias set) + one unused.
 *   2. formatInvitesTable() rendering: pure-function unit tests — no DB needed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import {
  createInvite,
  redeemInvite,
  listInvites,
  type KeyDefaults,
} from "../src/homeserver/keystore.js";
import { formatInvitesTable } from "../src/homeserver/cli.js";

const DEFAULTS: KeyDefaults = { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 };

// ── DB setup — fresh isolated DB for this test file ──────────────────────────

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-cli-invites-test-"));
  initDb(join(dir, "test.db"));
});

// ── listInvites() integration tests ──────────────────────────────────────────

describe("listInvites — create + redeem lifecycle", () => {
  it("returns empty array when no invites exist", () => {
    expect(listInvites()).toEqual([]);
  });

  it("reflects one redeemed (redeemedKeyAlias set) + one unused after create 2 / redeem 1", () => {
    // Create two invites with distinct labels
    const { code: code1 } = createInvite({
      label: "alice-invite",
      tier: "guest",
      creditLimit: 50_000,
      aliasPrefix: "alice",
    });
    createInvite({
      label: "bob-invite",
      tier: "guest",
      creditLimit: 100_000,
      aliasPrefix: "bob",
    });

    // Redeem the first invite (alice's)
    const minted = redeemInvite(code1, DEFAULTS);
    const redeemedAlias = minted.record.alias;

    const invites = listInvites();
    expect(invites).toHaveLength(2);

    const alice = invites.find((i) => i.label === "alice-invite");
    const bob = invites.find((i) => i.label === "bob-invite");

    // Alice's invite should be redeemed with her new key alias
    expect(alice).toBeDefined();
    expect(alice!.redeemedKeyAlias).toBe(redeemedAlias);
    expect(alice!.redeemedAt).not.toBeNull();
    expect(alice!.tier).toBe("guest");
    expect(alice!.creditLimit).toBe(50_000);

    // Bob's invite should still be unused
    expect(bob).toBeDefined();
    expect(bob!.redeemedKeyAlias).toBeNull();
    expect(bob!.redeemedAt).toBeNull();
    expect(bob!.creditLimit).toBe(100_000);
  });

  it("creditLimit 0 (unlimited) is preserved through the invite", () => {
    createInvite({ label: "unlimited-invite", tier: "owner", creditLimit: 0 });
    const inv = listInvites().find((i) => i.label === "unlimited-invite");
    expect(inv).toBeDefined();
    expect(inv!.creditLimit).toBe(0);
    expect(inv!.tier).toBe("owner");
  });
});

// ── formatInvitesTable() pure-function unit tests ─────────────────────────────

describe("formatInvitesTable — rendering", () => {
  it("returns friendly 'no invites' message for empty array", () => {
    const out = formatInvitesTable([]);
    expect(out).toMatch(/no invites yet/i);
  });

  it("renders 'unused' status for an unredeemed invite", () => {
    const out = formatInvitesTable([
      {
        label: "test-unused",
        tier: "guest",
        creditLimit: 5_000,
        modelAllowList: [],
        aliasPrefix: "test",
        createdAt: "2026-06-18T10:00:00.000Z",
        redeemedAt: null,
        redeemedKeyAlias: null,
      },
    ]);
    expect(out).toContain("unused");
    expect(out).not.toContain("redeemed");
  });

  it("renders 'redeemed → <alias>' for a redeemed invite", () => {
    const out = formatInvitesTable([
      {
        label: "test-redeemed",
        tier: "guest",
        creditLimit: 5_000,
        modelAllowList: [],
        aliasPrefix: "test",
        createdAt: "2026-06-18T10:00:00.000Z",
        redeemedAt: "2026-06-18T12:00:00.000Z",
        redeemedKeyAlias: "alice-3f9a",
      },
    ]);
    expect(out).toContain("redeemed → alice-3f9a");
    expect(out).not.toContain("unused");
  });

  it("renders 'unlimited' when creditLimit is 0", () => {
    const out = formatInvitesTable([
      {
        label: "test-unlimited",
        tier: "owner",
        creditLimit: 0,
        modelAllowList: [],
        aliasPrefix: "owner",
        createdAt: "2026-06-18T10:00:00.000Z",
        redeemedAt: null,
        redeemedKeyAlias: null,
      },
    ]);
    expect(out).toContain("unlimited");
    // "unlimited" should appear in the CREDITS column position, not the numeric "0"
    // Verify the row for test-unlimited uses "unlimited" and not a raw "0" in the credits slot
    const dataRow = out.split("\n").find((l) => l.includes("test-unlimited"))!;
    expect(dataRow).toContain("unlimited");
    // The credits column must not be "0" (would be padded with spaces, but let's check the slot isn't "0 ")
    expect(dataRow).not.toMatch(/\s0\s{10,}/); // "0" followed by 10+ spaces = padded 0 in a 12-wide column
  });

  it("renders a header row containing expected column names", () => {
    const out = formatInvitesTable([
      {
        label: "hdr-test",
        tier: "guest",
        creditLimit: 1_000,
        modelAllowList: [],
        aliasPrefix: "hdr",
        createdAt: "2026-06-18T10:00:00.000Z",
        redeemedAt: null,
        redeemedKeyAlias: null,
      },
    ]);
    expect(out).toContain("LABEL");
    expect(out).toContain("TIER");
    expect(out).toContain("CREDITS");
    expect(out).toContain("CREATED");
    expect(out).toContain("STATUS");
  });

  it("trims createdAt to YYYY-MM-DD date only", () => {
    const out = formatInvitesTable([
      {
        label: "date-test",
        tier: "guest",
        creditLimit: 1_000,
        modelAllowList: [],
        aliasPrefix: "d",
        createdAt: "2026-06-18T10:00:00.000Z",
        redeemedAt: null,
        redeemedKeyAlias: null,
      },
    ]);
    expect(out).toContain("2026-06-18");
    // The time portion should NOT appear
    expect(out).not.toContain("T10:00");
  });

  it("renders both redeemed and unused rows in a multi-invite table", () => {
    const out = formatInvitesTable([
      {
        label: "carol",
        tier: "guest",
        creditLimit: 1_000,
        modelAllowList: [],
        aliasPrefix: "carol",
        createdAt: "2026-06-01T00:00:00.000Z",
        redeemedAt: "2026-06-02T00:00:00.000Z",
        redeemedKeyAlias: "carol-ab12",
      },
      {
        label: "dave",
        tier: "guest",
        creditLimit: 2_000,
        modelAllowList: [],
        aliasPrefix: "dave",
        createdAt: "2026-06-03T00:00:00.000Z",
        redeemedAt: null,
        redeemedKeyAlias: null,
      },
    ]);
    expect(out).toContain("redeemed → carol-ab12");
    expect(out).toContain("unused");
    expect(out).toContain("carol");
    expect(out).toContain("dave");
  });
});
