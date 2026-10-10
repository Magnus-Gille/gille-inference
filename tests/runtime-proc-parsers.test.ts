import { describe, expect, it } from "vitest";

import { findLoopbackListener, parseProcessStartTicks } from "../src/homeserver/runtime-proc-parsers.js";

function statLine(pid: string, comm: string, state: string, starttime: string, fields = 19): string {
  const afterState = Array.from({ length: fields }, (_, index) =>
    index === fields - 1 ? starttime : String(index + 1),
  );
  return `${pid} (${comm}) ${state} ${afterState.join(" ")}\n`;
}

const TABLE_HEADER = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
const TABLE6_HEADER = "sl local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";

function tcpRow({
  slot = 0,
  address = "0100007F",
  port = 8080,
  remote = "00000000",
  state = "0A",
  inode = "12345",
}: {
  slot?: number;
  address?: string;
  port?: number;
  remote?: string;
  state?: string;
  inode?: string;
} = {}): string {
  const remoteAddress = address.length === 32 ? "00000000000000000000000000000000" : remote;
  return `${slot}: ${address}:${port.toString(16).padStart(4, "0")} ${remoteAddress}:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`;
}

function tcpTable(rows: string[], ipv6 = false): string {
  const header = ipv6 ? TABLE6_HEADER : TABLE_HEADER;
  return rows.length === 0 ? `${header}\n` : `${header}\n${rows.join("\n")}\n`;
}

describe("parseProcessStartTicks", () => {
  it("parses field 22 when comm contains spaces and parentheses", () => {
    expect(parseProcessStartTicks(statLine("123", "worker (gpu) v2", "S", "456789"), 123)).toBe("456789");
  });

  it("accepts zero and the uint64 maximum as canonical decimal ticks", () => {
    expect(parseProcessStartTicks(statLine("123", "worker", "R", "0000"), 123)).toBe("0");
    expect(parseProcessStartTicks(statLine("123", "worker", "R", "18446744073709551615"), 123)).toBe(
      "18446744073709551615",
    );
  });

  it.each([
    ["pid reuse", statLine("124", "worker", "S", "456") , 123],
    ["malformed pid", statLine("12x", "worker", "S", "456"), 12],
    ["missing close parenthesis", "123 (worker S 1 2 3\n", 123],
    ["malformed state", statLine("123", "worker", "SS", "456"), 123],
    ["unknown state", statLine("123", "worker", "Q", "456"), 123],
    ["zombie state", statLine("123", "worker", "Z", "456"), 123],
    ["dead state", statLine("123", "worker", "X", "456"), 123],
    ["lowercase dead state", statLine("123", "worker", "x", "456"), 123],
    ["truncated fields", statLine("123", "worker", "S", "456", 18), 123],
    ["malformed starttime", statLine("123", "worker", "S", "12x"), 123],
    ["starttime over uint64", statLine("123", "worker", "S", "18446744073709551616"), 123],
    ["unsafe pid", statLine("9007199254740992", "worker", "S", "456"), 9007199254740992],
  ] as const)("rejects %s", (_name, text, pid) => {
    expect(parseProcessStartTicks(text, pid)).toBeNull();
  });

  it("rejects input over the 64 KiB UTF-8 limit", () => {
    expect(parseProcessStartTicks(`${statLine("123", "worker", "S", "456")}${"x".repeat(65_536)}`, 123)).toBeNull();
  });
});

describe("findLoopbackListener", () => {
  it("returns the sole exact IPv4 listener and ignores an established row", () => {
    const tcp = tcpTable([
      tcpRow({ inode: "777" }),
      tcpRow({ slot: 1, state: "01", inode: "778" }),
    ]);
    expect(findLoopbackListener(tcp, tcpTable([], true), "127.0.0.1", 8080)).toBe("777");
  });

  it("returns the sole exact IPv6 listener", () => {
    const tcp6 = tcpTable([tcpRow({ address: "00000000000000000000000001000000", inode: "888" })], true);
    expect(findLoopbackListener(tcpTable([]), tcp6, "[::1]", 8080)).toBe("888");
  });

  it.each([
    ["wildcard", tcpRow({ address: "00000000" }), tcpTable([], true), "127.0.0.1"],
    ["other IPv4 address", tcpRow({ address: "01000001" }), tcpTable([], true), "127.0.0.1"],
    ["IPv4 listener when IPv6 requested", tcpRow(), tcpTable([], true), "[::1]"],
    ["duplicate same-port listeners", `${tcpRow({ inode: "1" })}\n${tcpRow({ slot: 1, inode: "2" })}`, tcpTable([], true), "127.0.0.1"],
    ["same-port listener in the other table", tcpRow(), tcpTable([tcpRow({ address: "00000000000000000000000001000000", inode: "2" })], true), "127.0.0.1"],
  ] as const)("rejects %s", (_name, tcp, tcp6, hostname) => {
    expect(findLoopbackListener(tcpTable(tcp.includes("\n") ? tcp.split("\n") : [tcp]), tcp6, hostname, 8080)).toBeNull();
  });

  it("rejects duplicate inode identity across tables", () => {
    expect(findLoopbackListener(tcpTable([tcpRow({ inode: "42" })]), tcpTable([tcpRow({ address: "00000000000000000000000001000000", inode: "42" })], true), "127.0.0.1", 8080)).toBeNull();
  });

  it("ignores established activity when no listener exists", () => {
    expect(findLoopbackListener(tcpTable([tcpRow({ state: "01" })]), tcpTable([], true), "127.0.0.1", 8080)).toBeNull();
  });

  it("allows zero and duplicate inodes for non-listening TCP rows", () => {
    const tcp = tcpTable([
      tcpRow({ state: "06", inode: "0" }),
      tcpRow({ slot: 1, state: "06", inode: "0" }),
      tcpRow({ slot: 2, state: "01", inode: "321" }),
      tcpRow({ slot: 3, state: "01", inode: "321" }),
      tcpRow({ slot: 4, inode: "999" }),
    ]);
    expect(findLoopbackListener(tcp, tcpTable([], true), "127.0.0.1", 8080)).toBe("999");
  });

  it.each([
    ["missing header", "", tcpTable([], true)],
    ["malformed row", `${TABLE_HEADER}\n0: 0100007F:1F90`, tcpTable([], true)],
    ["bad inode", tcpTable([tcpRow({ inode: "0" })]), tcpTable([], true)],
    ["inode over uint64", tcpTable([tcpRow({ inode: "18446744073709551616" })]), tcpTable([], true)],
    ["bad address hex", tcpTable([tcpRow({ address: "0100007G" })]), tcpTable([], true)],
    ["bad state", tcpTable([tcpRow({ state: "ZZ" })]), tcpTable([], true)],
  ] as const)("fails closed for %s", (_name, tcp, tcp6) => {
    expect(findLoopbackListener(tcp, tcp6, "127.0.0.1", 8080)).toBeNull();
  });

  it("rejects more than 4096 rows", () => {
    const rows = Array.from({ length: 4097 }, (_, index) => tcpRow({ slot: index, port: 8081, inode: String(index + 1) }));
    expect(findLoopbackListener(tcpTable(rows), tcpTable([], true), "127.0.0.1", 8080)).toBeNull();
  });

  it("rejects a table over the 1 MiB UTF-8 limit", () => {
    expect(findLoopbackListener(`${TABLE_HEADER}\n${"x".repeat(1_048_576)}`, tcpTable([], true), "127.0.0.1", 8080)).toBeNull();
  });
});
