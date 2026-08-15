import { describe, expect, it } from "vitest";

import {
  restoreResidency,
  runningSnapshot,
  unloadAll,
  type StrixResidencyDependencies,
} from "../src/homeserver/strix-residency.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Strix llama-swap residency helpers", () => {
  it("validates content-blind residency evidence", async () => {
    const dependencies: StrixResidencyDependencies = {
      fetch: async () => json({ running: [{ model: "resident", state: "ready", ttl: 7 }] }),
      sleep: async () => {},
      now: () => 0,
    };
    await expect(runningSnapshot("http://127.0.0.1:8091", dependencies)).resolves.toEqual([
      { model: "resident", state: "ready", ttl: 7 },
    ]);
    await expect(runningSnapshot("http://127.0.0.1:8091", {
      ...dependencies, fetch: async () => json({ running: [{ model: 1, state: "ready" }] }),
    })).rejects.toThrow(/malformed residency entries/);
  });

  it("waits until unload is observably empty", async () => {
    let snapshots = 0;
    const dependencies: StrixResidencyDependencies = {
      fetch: async (input, init) => {
        if (String(input).endsWith("/api/models/unload")) return json({ ok: true });
        snapshots++;
        return json({ running: snapshots === 1 ? [{ model: "resident", state: "ready" }] : [] });
      },
      sleep: async () => {},
      now: (() => { let value = 0; return () => value += 1; })(),
    };
    await expect(unloadAll("http://127.0.0.1:8091", dependencies)).resolves.toBeUndefined();
    expect(snapshots).toBe(2);
  });

  it("requires an exact OK inference before accepting restored readiness", async () => {
    let ready = false;
    const requests: string[] = [];
    const dependencies: StrixResidencyDependencies = {
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/api/models/unload")) { ready = false; return json({ ok: true }); }
        if (url.endsWith("/v1/chat/completions")) { ready = true; return json({ choices: [{ message: { content: "OK" } }] }); }
        return json({ running: ready ? [{ model: "resident", state: "ready" }] : [] });
      },
      sleep: async () => {},
      now: (() => { let value = 0; return () => value += 1; })(),
    };
    await expect(restoreResidency("http://127.0.0.1:8091", [{ model: "resident", state: "ready" }], dependencies)).resolves.toBeUndefined();
    expect(requests.some((request) => request.endsWith("/v1/chat/completions"))).toBe(true);
    await expect(restoreResidency("http://127.0.0.1:8091", [{ model: "resident", state: "ready" }], {
      ...dependencies,
      fetch: async (input) => String(input).endsWith("/v1/chat/completions")
        ? json({ choices: [{ message: { content: "not ok" } }] })
        : String(input).endsWith("/api/models/unload") ? json({ ok: true }) : json({ running: [] }),
    })).rejects.toThrow(/exact OK/);
  });
});
