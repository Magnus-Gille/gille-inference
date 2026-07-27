import { describe, expect, it } from "vitest";
import { initializeGatewayRegistries } from "../src/homeserver/gateway.js";

describe("gateway registry startup diagnostics", () => {
  it("attributes roster-proposal schema initialization failures to roster proposals", () => {
    expect(() => initializeGatewayRegistries({
      initializeTaskExposureRegistry: () => {},
      ensureRosterProposalSchema: () => {
        throw new Error("existing roster_proposals schema is incompatible");
      },
      expireRosterProposals: () => {},
    })).toThrow(
      "Could not initialize roster proposal registry: existing roster_proposals schema is incompatible",
    );
  });

  it("retains task-exposure attribution for task-exposure registry failures", () => {
    expect(() => initializeGatewayRegistries({
      initializeTaskExposureRegistry: () => {
        throw new Error("task exposure schema is incompatible");
      },
      ensureRosterProposalSchema: () => {},
      expireRosterProposals: () => {},
    })).toThrow(
      "Could not initialize task exposure registry: task exposure schema is incompatible",
    );
  });
});
