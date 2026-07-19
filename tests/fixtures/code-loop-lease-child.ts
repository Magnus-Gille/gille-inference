import { acquireDurableCodeLoopLease } from "../../src/homeserver/code-loop-store.js";

const [workroot, workId] = process.argv.slice(2);
if (workroot === undefined || workId === undefined) throw new Error("usage: code-loop-lease-child <workroot> <work-id>");

const claim = acquireDurableCodeLoopLease(workroot, workId);
const result = `${JSON.stringify({ kind: claim.kind, work_id: claim.kind === "acquired" ? workId : claim.work_id })}\n`;
if (claim.kind === "busy") {
  process.stdout.write(result, () => process.exit(0));
} else {
  process.stdout.write(result);
}

if (claim.kind === "acquired") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (!chunk.includes("release")) return;
    claim.lease.release();
    process.exit(0);
  });
  process.stdin.resume();
}
