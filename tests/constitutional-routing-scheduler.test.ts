import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestJson } from "../src/homeserver/autonomy-contract-v1.js";
import {
  composeImmutablePlan,
  parseRouteMutationProposal,
  persistImmutablePlan,
  removeExpiredImmutablePlan,
} from "../src/homeserver/constitutional-routing-scheduler.js";

function proposal() {
  const base = {
    schema_version: 1 as const,
    proposal_id: "measured-route-candidate",
    candidate: '{"route":"qwen"}\n',
    target_scope_digest: `sha256:${"1".repeat(64)}`,
    config_digest: `sha256:${"2".repeat(64)}`,
    evidence_digest: `sha256:${"3".repeat(64)}`,
    policy_digest: `sha256:${"4".repeat(64)}`,
    postconditions_digest: `sha256:${"5".repeat(64)}`,
    content_ref: "ref:measured-route-candidate",
  };
  return { ...base, proposal_digest: digestJson(base) };
}

describe("constitutional scheduler composition", () => {
  it("binds the immutable attempt to the complete ADR-008 v2 4200 second budget", () => {
    const parsed = parseRouteMutationProposal(proposal());
    const plan = composeImmutablePlan(parsed, '{"route":"mellum"}\n', {} as any, "2026-07-27T10:00:00Z", "abcdef123456");
    expect(plan).not.toHaveProperty("watchDeadline");
    expect(plan.deadline).toBe("2026-07-27T11:10:00Z");
  });

  it("rejects non-exact UTC and tampered proposals", () => {
    expect(() => parseRouteMutationProposal({ ...proposal(), candidate: "tampered" })).toThrow(/invalid/);
    expect(() => composeImmutablePlan(
      parseRouteMutationProposal(proposal()),
      '{"route":"mellum"}\n',
      {} as any,
      "2026-07-27T10:00:00.500Z",
    )).toThrow(/exact-second/);
  });

  it("persists one immutable plan and refuses replacement across scheduler restarts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-plan-")), "plan.json");
    const plan = composeImmutablePlan(parseRouteMutationProposal(proposal()), '{"route":"mellum"}\n', {} as any, "2026-07-27T10:00:00Z", "abcdef123456");
    expect(persistImmutablePlan(path, plan)).toBe("created");
    expect(persistImmutablePlan(path, plan)).toBe("same");
    expect(() => persistImmutablePlan(path, { ...plan, candidate: "other" })).toThrow(/immutable/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ attemptId: plan.attemptId });
  });

  it("removes only an expired immutable plan so the scheduler cannot deadlock forever", () => {
    const path = join(mkdtempSync(join(tmpdir(), "constitutional-plan-expiry-")), "plan.json");
    const plan = composeImmutablePlan(
      parseRouteMutationProposal(proposal()),
      '{"route":"mellum"}\n',
      {} as any,
      "2026-07-27T10:00:00Z",
      "abcdef123456",
    );
    persistImmutablePlan(path, plan);
    expect(removeExpiredImmutablePlan(path, "2026-07-27T11:09:59Z")).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(removeExpiredImmutablePlan(path, "2026-07-27T11:10:00Z")).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeExpiredImmutablePlan(path, "2026-07-27T11:10:01Z")).toBe(false);
  });
});
