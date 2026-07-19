import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { clientIp, isTrustedProxy } from "../src/homeserver/gateway.js";

function mkReq(remoteAddress: string, cfHeader?: string): IncomingMessage {
  return {
    headers: cfHeader === undefined ? {} : { "cf-connecting-ip": cfHeader },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("clientIp trusted-proxy gating (rate-limit spoof defense)", () => {
  const LOOPBACK = ["127.0.0.1", "::1"];

  it("honors CF-Connecting-IP only from a trusted peer", () => {
    expect(clientIp(mkReq("127.0.0.1", "9.9.9.9"), LOOPBACK)).toBe("9.9.9.9");
  });

  it("ignores a spoofed CF-Connecting-IP from an untrusted peer", () => {
    // The exploit: an attacker on a non-proxy peer forges the header per request.
    expect(clientIp(mkReq("1.2.3.4", "9.9.9.9"), LOOPBACK)).toBe("1.2.3.4");
  });

  it("ignores the header entirely when no proxy is trusted (trust-none)", () => {
    expect(clientIp(mkReq("127.0.0.1", "9.9.9.9"), [])).toBe("127.0.0.1");
  });

  it("trusts a CIDR range and rejects peers outside it", () => {
    expect(clientIp(mkReq("10.5.6.7", "9.9.9.9"), ["10.0.0.0/8"])).toBe("9.9.9.9");
    expect(clientIp(mkReq("11.0.0.1", "9.9.9.9"), ["10.0.0.0/8"])).toBe("11.0.0.1");
  });

  it("normalizes IPv4-mapped IPv6 peers before matching", () => {
    expect(clientIp(mkReq("::ffff:127.0.0.1", "9.9.9.9"), ["127.0.0.1"])).toBe("9.9.9.9");
    expect(isTrustedProxy("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  });

  it("falls back to the socket address when no header is present", () => {
    expect(clientIp(mkReq("1.2.3.4"), ["127.0.0.1"])).toBe("1.2.3.4");
  });

  it("does not treat a malformed CIDR or bogus octets as a match", () => {
    expect(isTrustedProxy("10.0.0.1", ["10.0.0.0/33"])).toBe(false);
    expect(isTrustedProxy("10.0.0.1", ["10.0.0.256/24"])).toBe(false);
    expect(isTrustedProxy("not-an-ip", ["10.0.0.0/8"])).toBe(false);
  });
});
