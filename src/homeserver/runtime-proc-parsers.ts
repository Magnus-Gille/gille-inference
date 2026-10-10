const MAX_STAT_BYTES = 64 * 1024;
const MAX_TABLE_BYTES = 1024 * 1024;
const MAX_TABLE_ROWS = 4096;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;
const LIVE_PROCESS_STATES = new Set(["R", "S", "D", "T", "t", "W", "K", "P", "I"]);

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseDecimalUint64(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT64 ? parsed : null;
  } catch {
    return null;
  }
}

/** Return /proc/PID/stat's field 22 after confirming it belongs to expectedPid. */
export function parseProcessStartTicks(text: string, expectedPid: number): string | null {
  if (typeof text !== "string" || utf8ByteLength(text) > MAX_STAT_BYTES) return null;
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return null;

  const firstSpace = text.indexOf(" ");
  if (firstSpace <= 0 || text[firstSpace + 1] !== "(") return null;

  const pidText = text.slice(0, firstSpace);
  const pid = parseDecimalUint64(pidText);
  if (pid === null || pid === 0n || pid > MAX_SAFE_INTEGER || pid !== BigInt(expectedPid)) return null;

  // comm can contain spaces and parentheses. Linux places the state after the final ')'.
  const closeParen = text.lastIndexOf(")");
  if (closeParen <= firstSpace + 1) return null;

  const fields = text.slice(closeParen + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state), so field 22 is fields[19].
  if (fields.length < 20) return null;
  const state = fields[0];
  if (!LIVE_PROCESS_STATES.has(state)) return null;

  const starttime = parseDecimalUint64(fields[19]);
  return starttime === null ? null : starttime.toString(10);
}

type TcpRow = {
  address: string;
  port: number;
  state: number;
  inode: string;
};

function parseHex(value: string): bigint | null {
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(`0x${value}`);
  } catch {
    return null;
  }
}

function parseTcpTable(text: string, ipv6: boolean, seenInodes: Set<string>): TcpRow[] | null {
  if (typeof text !== "string" || utf8ByteLength(text) > MAX_TABLE_BYTES) return null;

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return null;

  const header = lines.shift();
  if (header === undefined) return null;
  const headerFields = header.endsWith("\r") ? header.slice(0, -1).trim().split(/\s+/) : header.trim().split(/\s+/);
  const expectedHeaderFields = [
    "sl",
    "local_address",
    ipv6 ? "remote_address" : "rem_address",
    "st",
    "tx_queue",
    "rx_queue",
    "tr",
    "tm->when",
    "retrnsmt",
    "uid",
    "timeout",
    "inode",
  ];
  if (
    headerFields.length < expectedHeaderFields.length ||
    expectedHeaderFields.some((field, index) => headerFields[index] !== field)
  ) {
    return null;
  }
  if (lines.length > MAX_TABLE_ROWS) return null;

  const expectedAddressLength = ipv6 ? 32 : 8;
  const rows: TcpRow[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") return null;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^\d+:$/.test(fields[0])) return null;
    const slot = parseDecimalUint64(fields[0].slice(0, -1));
    if (slot === null || slot > MAX_SAFE_INTEGER) return null;

    const local = fields[1].match(/^([0-9a-fA-F]+):([0-9a-fA-F]{4})$/);
    const remote = fields[2].match(/^([0-9a-fA-F]+):([0-9a-fA-F]{4})$/);
    if (local === null || remote === null || local[1].length !== expectedAddressLength || remote[1].length !== expectedAddressLength) {
      return null;
    }
    if (!/^[0-9a-fA-F]{2}$/.test(fields[3])) return null;
    if (!/^[0-9a-fA-F]{8}:[0-9a-fA-F]{8}$/.test(fields[4])) return null;
    if (!/^[0-9a-fA-F]{2}:[0-9a-fA-F]{8}$/.test(fields[5])) return null;
    if (!/^[0-9a-fA-F]{8}$/.test(fields[6])) return null;
    if (parseDecimalUint64(fields[7]) === null || parseDecimalUint64(fields[8]) === null) return null;

    const stateValue = parseHex(fields[3]);
    if (stateValue === null || stateValue > 0xffn) return null;

    const inodeValue = parseDecimalUint64(fields[9]);
    if (inodeValue === null || (stateValue === 0x0an && inodeValue === 0n)) return null;
    const inode = inodeValue.toString(10);
    if (stateValue === 0x0an) {
      if (seenInodes.has(inode)) return null;
      seenInodes.add(inode);
    }

    const portValue = parseHex(local[2]);
    if (portValue === null || portValue > 65_535n) return null;
    rows.push({ address: local[1].toUpperCase(), port: Number(portValue), state: Number(stateValue), inode });
  }
  return rows;
}

export function findLoopbackListener(
  tcp: string,
  tcp6: string,
  hostname: "127.0.0.1" | "[::1]",
  port: number,
): string | null {
  if ((hostname !== "127.0.0.1" && hostname !== "[::1]") || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  const seenInodes = new Set<string>();
  const ipv4Rows = parseTcpTable(tcp, false, seenInodes);
  const ipv6Rows = parseTcpTable(tcp6, true, seenInodes);
  if (ipv4Rows === null || ipv6Rows === null) return null;

  const expectedAddress = hostname === "127.0.0.1" ? "0100007F" : "00000000000000000000000001000000";
  let listener: string | null = null;
  for (const row of [...ipv4Rows, ...ipv6Rows]) {
    if (row.state !== 0x0a || row.port !== port) continue;
    if (row.address !== expectedAddress || listener !== null) return null;
    listener = row.inode;
  }
  return listener;
}
