import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
  { stdio: "ignore" },
);
writeFileSync(pidFile, String(descendant.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
