import { createConnection } from "node:net";

/**
 * A bounded, content-free reachability check of the dedicated user's session bus.
 * A file bind can leave the old socket inode visible after user@UID restarts;
 * checking that the pathname is a socket would report a false healthy state.
 * Connecting proves that a listener still owns the inode without sending data.
 */
export function probeCodeLoopTransport(
  path: string | undefined = typeof process.getuid === "function" ? `/run/user/${process.getuid()}/bus` : undefined,
  timeoutMs = 250,
): Promise<boolean> {
  if (!path) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ path });
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
