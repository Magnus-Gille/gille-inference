import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { setConfig, resetConfig } from "../src/homeserver/config.js";
import { currentModel } from "../src/homeserver/orchestrator.js";

/**
 * Regression for the router's local-model detection. `currentModel()` must resolve the loaded model
 * through the backend FACADE (model-admin), which for the llamaswap backend reads `/running`.
 *
 * The bug: orchestrator imported `getLoaded` straight from `lmstudio-admin`, which queries LM Studio's
 * REST path `/api/v1/models` — a 404 on a llama-swap box. That threw, was swallowed, and
 * `currentModel()` returned null, so the router escalated EVERY task to frontier instead of ever
 * delegating to a local model.
 */
describe("currentModel — resolves via the configured backend (llamaswap)", () => {
  let server: Server;
  let port = 0;
  let runningHits = 0;
  let lmStudioRestHits = 0;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/running") {
        runningHits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ running: [{ model: "test-model", state: "ready", cmd: "-c 8192", proxy: "", ttl: 1800 }] })
        );
        return;
      }
      // A real llama-swap box does NOT serve LM Studio's REST API — 404 exactly like the box.
      if (req.url?.startsWith("/api/v1/")) lmStudioRestHits++;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        r();
      })
    );
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    runningHits = 0;
    lmStudioRestHits = 0;
  });
  afterEach(() => {
    delete process.env["LLAMASWAP_BASE_URL"];
    resetConfig(); // don't leak backend:"llamaswap" + the dead test URLs into other suites
  });

  it("returns the running model via /running, never the LM Studio /api/v1/models 404 path", async () => {
    delete process.env["LLAMASWAP_BASE_URL"]; // origin derives from lmStudioBaseUrl below
    setConfig({
      backend: "llamaswap",
      lmStudioBaseUrl: `http://127.0.0.1:${port}/v1`,
      lmStudioRestUrl: `http://127.0.0.1:${port}/api/v1`, // would 404 — proves we do NOT use it
    });
    const model = await currentModel();
    expect(model).toBe("test-model");
    expect(runningHits).toBeGreaterThan(0); // hit the facade path (/running)
    expect(lmStudioRestHits).toBe(0); // never touched the LM Studio REST path
  });

  it("honours an explicit override without any backend call", async () => {
    expect(await currentModel("pinned-model")).toBe("pinned-model");
    expect(runningHits).toBe(0); // override returns early — no backend query at all
    expect(lmStudioRestHits).toBe(0);
  });
});
