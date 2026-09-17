/** Approved gateway address for lab-only Halogen runs (#323). No I/O here. */
import { networkInterfaces } from "node:os";

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
 * Shape: exactly `http://<host>:<port>` with an explicit port and no path,
 * query, fragment, or credentials. The hostname is validated in the exact
 * canonical form the HTTP client will resolve (via WHATWG URL parsing), so
 * inet_aton-style disguises (`0127.0.0.1`, `0x7f.0.0.1`, `127.0.0.1e0`)
 * cannot slip through a looser pre-check. The canonical host must be
 * loopback or one of this box's interface addresses (injectable for tests).
 * Anything else fails closed instead of sending the bearer to a stranger.
 */
export function parseGatewayBaseUrl(input: unknown, localAddresses?: readonly string[]): string {
  if (typeof input !== "string" || input === "") throw new Error("approved gateway address required");
  const raw = /^http:\/\/([^/:?#@\s]+):(\d+)$/.exec(input);
  if (!raw) throw new Error(`malformed gateway address (want http://<host>:<port>): ${input}`);
  const port = Number(raw[2]!);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`gateway port out of range in: ${input}`);
  }
  let hostname: string;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:") throw new Error();
    if (parsed.username !== "" || parsed.password !== "") throw new Error();
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw new Error();
    hostname = parsed.hostname;
  } catch {
    throw new Error(`malformed gateway address (want http://<host>:<port>): ${input}`);
  }
  if (raw[1]!.toLowerCase() !== hostname) {
    throw new Error(`gateway host is not in canonical form (client would resolve ${hostname}): ${input}`);
  }
  const octets = hostname.split(".");
  const loopbackV4 =
    hostname === "localhost" ||
    (octets.length === 4 &&
      octets[0] === "127" &&
      octets.slice(1).every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255));
  if (!loopbackV4) {
    const local = new Set((localAddresses ?? defaultLocalAddresses()).map((a) => a.toLowerCase()));
    if (!local.has(hostname)) {
      throw new Error(`gateway host is not this box (credential must stay local): ${hostname}`);
    }
  }
  return input;
}
