import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "scripts", "verify-public-edge.sh");

function fakeCurl(dir: string, redirectStatus = "308", hsts = "max-age=31536000"): string {
  const bin = join(dir, "curl");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
printf '%s\\n' "\$url" >> "\$CURL_LOG"
case "\$url" in
  http://edge.test/*)
    path="\${url#http://edge.test}"
    printf 'HTTP/1.1 ${redirectStatus} Permanent Redirect\\r\\nLocation: https://edge.test%s\\r\\n\\r\\n' "\$path"
    ;;
  https://edge.test/portal)
    printf "%s\\r\\n" \\
      'HTTP/1.1 200 OK' \\
      'Strict-Transport-Security: ${hsts}' \\
      "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'" \\
      'X-Frame-Options: DENY' \\
      'Referrer-Policy: no-referrer' \\
      'Permissions-Policy: geolocation=(), camera=(), microphone=()' \\
      ''
    ;;
  *) exit 9 ;;
esac
`
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("scripts/verify-public-edge.sh", () => {
  it("checks permanent redirects for public and authenticated paths plus HTTPS portal headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-edge-"));
    try {
      fakeCurl(dir);
      const log = join(dir, "curl.log");
      const result = execFileSync("bash", [SCRIPT, "http://edge.test", "https://edge.test"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CURL_LOG: log },
        encoding: "utf8",
      });
      expect(result).toContain("HTTPS portal advertises HSTS");
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "http://edge.test/",
        "http://edge.test/hs",
        "http://edge.test/portal/redeem",
        "http://edge.test/v1/models?probe=public-edge",
        "http://edge.test/missing?probe=public-edge",
        "https://edge.test/portal",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a plaintext application response instead of certifying it", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-edge-"));
    try {
      fakeCurl(dir, "200");
      expect(() => execFileSync("bash", [SCRIPT, "http://edge.test", "https://edge.test"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CURL_LOG: join(dir, "curl.log") },
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow(/expected one permanent redirect/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects HSTS max-age=0 instead of treating it as an active HSTS policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-edge-"));
    try {
      fakeCurl(dir, "308", "max-age=0");
      expect(() => execFileSync("bash", [SCRIPT, "http://edge.test", "https://edge.test"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CURL_LOG: join(dir, "curl.log") },
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow(/positive HSTS max-age/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-origin URLs and mismatched HTTP/HTTPS authorities before making requests", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-edge-"));
    try {
      fakeCurl(dir);
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CURL_LOG: join(dir, "curl.log") };
      expect(() => execFileSync("bash", [SCRIPT, "http://edge.test/path", "https://edge.test"], {
        env, encoding: "utf8", stdio: "pipe",
      })).toThrow(/origin only/);
      expect(() => execFileSync("bash", [SCRIPT, "http://edge.test", "https://other.test"], {
        env, encoding: "utf8", stdio: "pipe",
      })).toThrow(/same host and port/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
