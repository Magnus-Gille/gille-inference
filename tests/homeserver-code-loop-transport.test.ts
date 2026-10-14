import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeCodeLoopTransport } from "../src/homeserver/code-loop-transport.js";

describe("code-loop user-manager transport", () => {
  it("reports a live bus socket, then reports it unavailable after the listener stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gille-user-bus-"));
    const path = join(dir, "bus");
    const server = createServer((socket) => socket.end());
    try {
      await new Promise<void>((resolve, reject) => server.listen(path, () => resolve()).once("error", reject));
      expect(await probeCodeLoopTransport(path)).toBe(true);
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      expect(await probeCodeLoopTransport(path)).toBe(false);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for a missing socket", async () => {
    expect(await probeCodeLoopTransport(join(tmpdir(), "gille-nonexistent-user-bus"))).toBe(false);
  });
});
