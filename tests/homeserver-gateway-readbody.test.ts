import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { readBody } from "../src/homeserver/gateway.js";

class FakeRequest extends EventEmitter {
  headers: Record<string, string>;
  destroyed = false;
  resumed = false;

  constructor(headers: Record<string, string> = {}) {
    super();
    this.headers = headers;
  }

  resume(): void {
    this.resumed = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function asRequest(req: FakeRequest): IncomingMessage {
  return req as unknown as IncomingMessage;
}

describe("readBody idle-read bound", () => {
  it("drops a stalled body read like a slow-loris client", async () => {
    const req = new FakeRequest({ "content-length": "100" });
    const pending = readBody(asRequest(req), 1024, 25);
    await expect(pending).rejects.toThrow("request body read timed out");
    expect(req.destroyed).toBe(true);
  });

  it("resets the idle clock on every chunk", async () => {
    const req = new FakeRequest();
    const pending = readBody(asRequest(req), 1024, 60);
    setTimeout(() => req.emit("data", Buffer.from("hel")), 30);
    setTimeout(() => req.emit("data", Buffer.from("lo")), 70);
    setTimeout(() => req.emit("end"), 115);
    await expect(pending).resolves.toBe("hello");
    expect(req.destroyed).toBe(false);
  });

  it("rejects a declared over-cap Content-Length without reading", async () => {
    const req = new FakeRequest({ "content-length": "9999" });
    await expect(readBody(asRequest(req), 8, 60)).rejects.toThrow("request body too large");
    expect(req.destroyed).toBe(false);
    expect(req.resumed).toBe(true);
  });

  it("rejects an over-cap streamed body and keeps the connection writable", async () => {
    const req = new FakeRequest();
    const pending = readBody(asRequest(req), 4, 60);
    req.emit("data", Buffer.from("12345"));
    await expect(pending).rejects.toThrow("request body too large");
    expect(req.destroyed).toBe(false);
    expect(req.resumed).toBe(true);
  });
});
