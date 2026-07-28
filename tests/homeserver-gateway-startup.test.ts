import { describe, expect, it } from "vitest";
import { initializeGatewayRegistries } from "../src/homeserver/gateway.js";

describe("gateway registry startup diagnostics", () => {
  it("attributes roster-proposal schema initialization failures to roster proposals", () => {
    const original = new TypeError("existing roster_proposals schema is incompatible");
    try {
      initializeGatewayRegistries({
        initializeTaskExposureRegistry: () => {},
        ensureRosterProposalSchema: () => {
          throw original;
        },
        expireRosterProposals: () => {},
      });
      throw new Error("expected roster-proposal initialization to fail");
    } catch (error) {
      const wrapped = error as Error & { cause?: unknown };
      expect(wrapped.message).toBe(
        "Could not initialize roster proposal registry: existing roster_proposals schema is incompatible",
      );
      expect(wrapped.cause).toBe(original);
      expect((wrapped.cause as Error).stack).toBe(original.stack);
    }
  });

  it("retains task-exposure attribution for task-exposure registry failures", () => {
    const original = new RangeError("task exposure schema is incompatible");
    try {
      initializeGatewayRegistries({
        initializeTaskExposureRegistry: () => {
          throw original;
        },
        ensureRosterProposalSchema: () => {},
        expireRosterProposals: () => {},
      });
      throw new Error("expected task-exposure initialization to fail");
    } catch (error) {
      const wrapped = error as Error & { cause?: unknown };
      expect(wrapped.message).toBe(
        "Could not initialize task exposure registry: task exposure schema is incompatible",
      );
      expect(wrapped.cause).toBe(original);
      expect((wrapped.cause as Error).stack).toBe(original.stack);
    }
  });
});
