import { readFileSync } from "node:fs";
import { CODE_LOOP_HARNESS_VERSION } from "./code-loop.js";

// git archive substitutes the accepted commit through .gitattributes. An ordinary
// checkout retains the placeholder and reports unknown, without running git or
// trusting a mutable deployment marker. The exported code binds the running process.
const ARCHIVE_REVISION = "$Format:%H$";
export function parseArchiveRevision(value: string): string | null {
  return /^[a-f0-9]{40}$/.test(value) ? value : null;
}
function bundledClientVersion(): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL("../../client/package.json", import.meta.url), "utf8"));
    if (value === null || typeof value !== "object" || !("version" in value)) return null;
    return typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : null;
  } catch { return null; } // Unavailable package evidence remains unknown; no path/error is exposed.
}
export const gatewayRelease = Object.freeze({
  revision: parseArchiveRevision(ARCHIVE_REVISION),
  client_version: bundledClientVersion(),
  result_contract: CODE_LOOP_HARNESS_VERSION,
});
