import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("deploy capability probe privacy", () => {
  it("passes authentication through stdin, never curl argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "capability-argv-")); dirs.push(dir);
    writeFileSync(join(dir, "curl"), `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$TEST_ARGS"
cat > "$TEST_STDIN"
printf '200'
`);
    chmodSync(join(dir, "curl"), 0o755);
    const source = readFileSync(new URL("../scripts/deploy-gateway.sh", import.meta.url), "utf8");
    const probe = source.match(/probe_capability\(\) \{[\s\S]*?\n\}/)![0];
    const key = "test_capability_secret_must_not_enter_argv";
    const output = execFileSync("bash", ["-c", probe + "\nprobe_capability"], { encoding: "utf8", env: {
      PATH: dir + ":/usr/bin:/bin", DEPLOY_CAPABILITY_URL: "http://example.invalid/capabilities",
      DEPLOY_CAPABILITY_KEY_ENV: "TEST_KEY", TEST_KEY: key,
      TEST_ARGS: join(dir, "args"), TEST_STDIN: join(dir, "stdin"),
    }});
    expect(readFileSync(join(dir, "args"), "utf8")).not.toContain(key);
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("Authorization: Bearer " + key + "\n");
    expect(output).not.toContain(key);
  });
});
