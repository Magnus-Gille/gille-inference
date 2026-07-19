import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Codex review of PR #218: the nightly wrapper's .env allow-list loader must get four semantic
 * cases right, or HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES silently reverts to its default and
 * mode=on could write verdicts for the excluded catch-all bucket:
 *   1. ambient set-but-EMPTY must win over .env (presence beats content),
 *   2. an .env line with an empty RHS must export EMPTY (explicit disable, not fallback),
 *   3. dotenv-quoted values must export with the quotes stripped,
 *   4. unset + no .env line → variable stays unset.
 * The test executes the REAL loader block, extracted verbatim from deploy/harvest-nightly.sh
 * between its `# --- env-allowlist start/end ---` markers, so wrapper and test cannot drift.
 */

const WRAPPER = join(__dirname, "..", "deploy", "harvest-nightly.sh");

function loaderBlock(): string {
  const src = readFileSync(WRAPPER, "utf8");
  const m = src.match(/# --- env-allowlist start ---\n([\s\S]*?)# --- env-allowlist end ---/);
  if (!m) throw new Error("env-allowlist markers not found in harvest-nightly.sh");
  return m[1]!;
}

/** Run the loader against a fixture .env and report the resulting values (RC-delimited). */
function runLoader(envFileContent: string | null, ambient: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "hv-env-"));
  try {
    if (envFileContent !== null) writeFileSync(join(dir, ".env"), envFileContent);
    const probe = [
      "REPO=" + JSON.stringify(dir),
      loaderBlock(),
      // report presence + value for the vars under test, unambiguously
      'for _r in HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES HARVEST_JUDGE_CTX_WINDOW HARVEST_CALL_TIMEOUT_MS; do',
      '  if declare -p "$_r" >/dev/null 2>&1; then printf "%s=SET:%s\\n" "$_r" "${!_r}"; else printf "%s=UNSET\\n" "$_r"; fi',
      "done",
    ].join("\n");
    const out = execFileSync("bash", ["-uc", probe], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...ambient },
    });
    const result: Record<string, string> = {};
    for (const line of out.trim().split("\n")) {
      const eq = line.indexOf("=");
      result[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("harvest-nightly.sh env allow-list loader (codex review of #218)", () => {
  it("an ambient set-but-EMPTY variable wins over a non-empty .env value (presence beats content)", () => {
    const r = runLoader('HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES=other\n', {
      HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES: "",
    });
    expect(r["HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES"]).toBe("SET:");
  });

  it("an .env line with an empty RHS exports EMPTY (explicit disable), not unset-fallback", () => {
    const r = runLoader("HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES=\n", {});
    expect(r["HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES"]).toBe("SET:");
  });

  it("strips one matching pair of dotenv quotes (double and single)", () => {
    const r = runLoader(
      'HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES="other, qa-factual"\nHARVEST_JUDGE_CTX_WINDOW=\'65536\'\n',
      {}
    );
    expect(r["HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES"]).toBe("SET:other, qa-factual");
    expect(r["HARVEST_JUDGE_CTX_WINDOW"]).toBe("SET:65536");
  });

  it("unset + no .env line stays unset; HARVEST_CALL_TIMEOUT_MS is in the allow-list", () => {
    const r = runLoader("HARVEST_CALL_TIMEOUT_MS=120000\n", {});
    expect(r["HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES"]).toBe("UNSET");
    expect(r["HARVEST_CALL_TIMEOUT_MS"]).toBe("SET:120000");
  });

  it("works with no .env file at all", () => {
    const r = runLoader(null, { HARVEST_JUDGE_CTX_WINDOW: "32768" });
    expect(r["HARVEST_JUDGE_CTX_WINDOW"]).toBe("SET:32768");
    expect(r["HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES"]).toBe("UNSET");
  });
});
