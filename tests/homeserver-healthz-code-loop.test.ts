import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../src/db.js";
import { createDirectGatewayHarness } from "./helpers/direct-gateway.js";

const before = process.env["HOMESERVER_CODE_LOOP"];
let testDir: string;
beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "hs-healthz-code-loop-"));
  initDb(join(testDir, "test.db"));
});
afterAll(() => rmSync(testDir, { recursive: true, force: true }));
afterEach(() => {
  if (before === undefined) delete process.env["HOMESERVER_CODE_LOOP"];
  else process.env["HOMESERVER_CODE_LOOP"] = before;
});

describe("content-free code-loop transport on healthz", () => {
  it("reports a stale bus as unavailable without taking ordinary gateway liveness down", async () => {
    process.env["HOMESERVER_CODE_LOOP"] = "on";
    const gateway = createDirectGatewayHarness(async () => false);
    const response = await gateway.invoke({ method: "GET", path: "/healthz" });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true, codeLoopTransport: "unavailable" });
  });

  it("reports a reachable bus as available and a disabled code-loop as disabled", async () => {
    process.env["HOMESERVER_CODE_LOOP"] = "on";
    const on = createDirectGatewayHarness(async () => true);
    expect((await on.invoke({ method: "GET", path: "/healthz" })).json).toMatchObject({ codeLoopTransport: "available" });
    process.env["HOMESERVER_CODE_LOOP"] = "off";
    const off = createDirectGatewayHarness(async () => { throw new Error("should not probe when disabled"); });
    expect((await off.invoke({ method: "GET", path: "/healthz" })).json).toMatchObject({ codeLoopTransport: "disabled" });
  });
});
