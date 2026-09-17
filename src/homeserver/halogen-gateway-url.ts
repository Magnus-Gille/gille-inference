/** Approved gateway address for lab-only Halogen runs (#323). No I/O here. */
import { networkInterfaces } from "node:os";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function defaultLocalAddresses(): string[] {
  const addresses: string[] = ["127.0.0.1", "localhost"];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) addresses.push(entry.address);
  }
  return [...new Set(addresses)];
}

/**
 * Parse an approved gateway base URL and prove it cannot carry the admin
 * credential off this box. Returns the URL unchanged on success.
 *
 * Shape: exactly `http://<host>:<port>` — no path, credentials, or other
 * scheme. The host must be loopback or one of this box's interface
 * addresses (injectable for tests). A typo pointing at a stranger fails
 * closed instead of sending the bearer there.
 */
export function parseGatewayBaseUrl(input: unknown, localAddresses?: readonly string[]): string {
  if (typeof input !== "string" || input === "") throw new Error("approved gateway address required");
  const match = /^http:\/\/([^/:@\s]+):(\d+)$/.exec(input);
  if (!match) throw new Error(`malformed gateway address (want http://<host>:<port>): ${input}`);
  const host = match[1]!;
  const port = Number(match[2]!);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`gateway port out of range in: ${input}`);
  }
  if (host !== "localhost" && !IPV4.test(host) && !HOSTNAME.test(host)) {
    throw new Error(`invalid gateway host in: ${input}`);
  }
  const lowered = host.toLowerCase();
  const local = new Set((localAddresses ?? defaultLocalAddresses()).map((a) => a.toLowerCase()));
  const loopbackV4 = lowered === "localhost" || lowered.split(".").every((part, index, all) => {
    if (all.length !== 4) return false;
    const n = Number(part);
    return index === 0 ? n === 127 : Number.isInteger(n) && n >= 0 && n <= 255;
  });
  if (!loopbackV4 && !local.has(lowered)) {
    throw new Error(`gateway host is not this box (credential must stay local): ${host}`);
  }
  return input;
}
