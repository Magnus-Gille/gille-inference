import { describe, it, expect } from "vitest";
import { describeCapturePolicy, CAPTURE_POLICY_CONTRACT, type CapturePolicyInput } from "../src/homeserver/capture-policy.js";
import { shouldCaptureOwnerContent } from "../src/homeserver/owner-log.js";

const NOW = new Date("2026-11-17T00:00:00.000Z");
const SCOPES = ["admin", "agent", "ask", "inference", "monitor"] as const;

function input(over: Partial<CapturePolicyInput> & { principal?: Partial<CapturePolicyInput["principal"]> } = {}): CapturePolicyInput {
  const { principal, ...rest } = over;
  return {
    ownerRequestLog: "on",
    requestLog: "on",
    optOutAvailable: true,
    embeddingGranted: false,
    now: NOW,
    ...rest,
    principal: { tier: "owner", scope: "agent", isAdmin: false, keyHash: "h", ...principal },
  };
}

describe("describeCapturePolicy (INFER-344)", () => {
  it("reports an observation time and a policy identity", () => {
    const p = describeCapturePolicy(input());
    expect(p.contract).toBe(CAPTURE_POLICY_CONTRACT);
    expect(p.observed_at).toBe(NOW.toISOString());
    expect(p.policy_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("policy_id changes when the effective policy changes and is stable otherwise", () => {
    const on = describeCapturePolicy(input()).policy_id;
    expect(describeCapturePolicy(input()).policy_id).toBe(on);
    expect(describeCapturePolicy(input({ ownerRequestLog: "off" })).policy_id).not.toBe(on);
    expect(describeCapturePolicy(input({ requestLog: "off" })).policy_id).not.toBe(on);
    expect(describeCapturePolicy(input({ principal: { scope: "ask" } })).policy_id).not.toBe(on);
  });

  it("owner chat/ask capture content when the owner log is on, and never claims known retention", () => {
    const p = describeCapturePolicy(input());
    for (const r of [p.routes.chat, p.routes.ask]) {
      expect(r.capture).toBe("content");
      expect(r.retention.horizon_days).toBe("unknown");
      expect(r.retention.declared_days).toBe(30);
      expect(r.per_call_opt_out).toBe(true);
    }
  });

  it("owner log off degrades to metadata only, never to 'none' while request_log is on", () => {
    const p = describeCapturePolicy(input({ ownerRequestLog: "off" }));
    expect(p.routes.chat.capture).toBe("metadata_only");
    expect(p.routes.chat.retention.horizon_days).toBe("unknown");
    expect(p.routes.chat.per_call_opt_out).toBe(false);
  });

  it("'none' only when no durable record exists, and then retention is not_applicable", () => {
    const p = describeCapturePolicy(input({ ownerRequestLog: "off", requestLog: "off" }));
    expect(p.routes.chat.capture).toBe("none");
    expect(p.routes.chat.retention.horizon_days).toBe("not_applicable");
  });

  it("guests and legacy static admins are never content-captured", () => {
    for (const principal of [
      { tier: "guest" as const, scope: "inference", keyHash: "h" },
      { tier: "owner" as const, scope: "admin", isAdmin: true, keyHash: null },
    ]) {
      const p = describeCapturePolicy(input({ principal }));
      expect(p.routes.chat.capture).toBe("metadata_only");
      expect(p.routes.ask.capture).toBe("metadata_only");
    }
  });

  it("tracks shouldCaptureOwnerContent for every tier x key x mode combination (no drift)", () => {
    for (const mode of ["on", "off"] as const) {
      for (const tier of ["owner", "guest"] as const) {
        for (const keyHash of ["h", null]) {
          const p = describeCapturePolicy(input({ ownerRequestLog: mode, principal: { tier, keyHash } }));
          const expected = shouldCaptureOwnerContent(mode, { tier, keyHash });
          expect(p.routes.chat.capture === "content").toBe(expected);
          expect(p.routes.ask.capture === "content").toBe(expected);
        }
      }
    }
  });

  it("separates tier from scope: availability follows scope, capture follows tier", () => {
    const ask = describeCapturePolicy(input({ principal: { scope: "ask" } }));
    expect(ask.routes.ask.available).toBe(true);
    expect(ask.routes.chat.available).toBe(false);
    expect(ask.routes.code_loop.available).toBe(false);
    expect(ask.routes.delegate.available).toBe(false);
    expect(ask.principal).toEqual({ tier: "owner", scope: "ask" });
    // ask scope is owner tier: its prompts are content-captured.
    expect(ask.routes.ask.capture).toBe("content");

    const inference = describeCapturePolicy(input({ principal: { scope: "inference" } }));
    expect(inference.routes.chat.available).toBe(true);
    expect(inference.routes.code_loop.available).toBe(false);

    const agent = describeCapturePolicy(input({ principal: { scope: "agent" } }));
    expect(agent.routes.code_loop.available).toBe(true);
    expect(agent.routes.delegate.available).toBe(false);

    const admin = describeCapturePolicy(input({ principal: { scope: "admin", isAdmin: true } }));
    expect(admin.routes.delegate.available).toBe(true);
  });

  it("monitor scope reaches no capture route", () => {
    const p = describeCapturePolicy(input({ principal: { scope: "monitor" } }));
    for (const r of Object.values(p.routes)) expect(r.available).toBe(false);
  });

  it("every scope x tier x config combination: content capture is never non-retaining", () => {
    for (const scope of SCOPES) {
      for (const tier of ["owner", "guest"] as const) {
        for (const ownerRequestLog of ["on", "off"] as const) {
          for (const requestLog of ["on", "off"] as const) {
            const p = describeCapturePolicy(input({
              ownerRequestLog, requestLog, embeddingGranted: true,
              principal: { tier, scope, isAdmin: scope === "admin" },
            }));
            for (const r of Object.values(p.routes)) {
              if (r.capture !== "none") expect(r.retention.horizon_days).not.toBe("not_applicable");
              if (r.capture === "content") expect(r.retention.horizon_days).toBe("unknown");
            }
          }
        }
      }
    }
  });

  it("code_loop and delegate keep content independent of the owner-log switch; delegate refuses the opt-out", () => {
    const p = describeCapturePolicy(input({
      ownerRequestLog: "off", principal: { scope: "admin", isAdmin: true },
    }));
    expect(p.routes.code_loop.capture).toBe("content");
    expect(p.routes.code_loop.per_call_opt_out).toBe(true);
    expect(p.routes.delegate.capture).toBe("content");
    expect(p.routes.delegate.per_call_opt_out).toBe(false);
  });

  it("per-call opt-out is not advertised when the gateway cannot honour it", () => {
    const p = describeCapturePolicy(input({ optOutAvailable: false, principal: { scope: "admin", isAdmin: true } }));
    expect(p.routes.chat.per_call_opt_out).toBe(false);
    expect(p.routes.ask.per_call_opt_out).toBe(false);
    expect(p.routes.code_loop.per_call_opt_out).toBe(false);
  });

  it("embeddings are content-blind and require a grant", () => {
    const denied = describeCapturePolicy(input());
    expect(denied.routes.embeddings.available).toBe(false);
    const granted = describeCapturePolicy(input({ embeddingGranted: true }));
    expect(granted.routes.embeddings.available).toBe(true);
    expect(granted.routes.embeddings.capture).toBe("metadata_only");
    expect(granted.routes.embeddings.per_call_opt_out).toBe(false);
  });

  it("output is content-free: no alias, key hash, path or config strings", () => {
    const json = JSON.stringify(describeCapturePolicy(input({
      principal: { keyHash: "SECRET-KEY-HASH-123" },
    })));
    expect(json).not.toContain("SECRET-KEY-HASH-123");
    expect(json).not.toMatch(/\/(home|srv|var|etc|Users)\b/);
    expect(json).not.toMatch(/alias|token|HOMESERVER_/i);
  });
});
