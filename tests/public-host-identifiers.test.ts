import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * This repository is public. The 2026-07-19 clean-history publication scrubbed the
 * owner's private domain and host addressing out of every tracked file, but nothing
 * enforced that afterwards — and the M5's real tailnet address subsequently landed in
 * a routing-lifecycle test (introduced in the #37/#38 fix). Secret scanning does not
 * catch this class: a tailnet IP and an internal hostname are not credentials, they
 * are host-identifying infrastructure detail.
 *
 * These tests are that missing guard. They read tracked files only, so an untracked
 * local STATUS.md or scratch note is deliberately out of scope.
 */

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

function readTracked(path: string): string | null {
  try {
    const raw = readFileSync(`${repoRoot}${path}`);
    // Skip binary blobs: a NUL byte in the first 8 KiB is the usual heuristic.
    if (raw.subarray(0, 8192).includes(0)) return null;
    return raw.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The owner's private inference domain. Public docs and examples must use
 * `inference.example.com`, which is what the publication scrub standardised on.
 */
const PRIVATE_DOMAIN = /\bgille\.ai\b/g;
const CANONICAL_GRIMNIR_SCHEMA_IDS = new Map<string, string>([
  ["contracts/grimnir-autonomy-v1/schemas/constitution.schema.json", "https://grimnir.gille.ai/contracts/autonomy-constitution/v1/schema.json"],
  ["contracts/grimnir-autonomy-v1/schemas/runtime-narrowing.schema.json", "https://grimnir.gille.ai/contracts/autonomy-runtime-narrowing/v1/schema.json"],
  ["contracts/grimnir-autonomy-v1/schemas/coverage.schema.json", "https://grimnir.gille.ai/contracts/autonomy-coverage-registry/v1/schema.json"],
  ["contracts/grimnir-autonomy-v1/schemas/owner-attestations.schema.json", "https://grimnir.gille.ai/contracts/autonomy-owner-attestation-registry/v1/schema.json"],
  ["contracts/grimnir-autonomy-v1/schemas/owner-authorization.schema.json", "https://grimnir.gille.ai/contracts/autonomy-owner-authorization/v1/schema.json"],
  ["contracts/grimnir-autonomy-v1/schemas/journal.schema.json", "https://grimnir.gille.ai/contracts/autonomous-mutation-journal/v1/schema.json"],
  ["contracts/grimnir-autonomy-v1/schemas/recovery-workers.schema.json", "https://grimnir.gille.ai/contracts/autonomy-recovery-worker-registry/v1/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/constitution.schema.json", "https://grimnir.gille.ai/contracts/autonomy-constitution/v2/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/runtime-narrowing.schema.json", "https://grimnir.gille.ai/contracts/autonomy-runtime-narrowing/v1/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/coverage.schema.json", "https://grimnir.gille.ai/contracts/autonomy-coverage-registry/v2/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/owner-attestations.schema.json", "https://grimnir.gille.ai/contracts/autonomy-owner-attestation-registry/v1/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/owner-authorization.schema.json", "https://grimnir.gille.ai/contracts/autonomy-owner-authorization/v1/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/journal.schema.json", "https://grimnir.gille.ai/contracts/autonomous-mutation-journal/v2/schema.json"],
  ["contracts/grimnir-autonomy-v2/schemas/recovery-workers.schema.json", "https://grimnir.gille.ai/contracts/autonomy-recovery-worker-registry/v1/schema.json"],
]);

function contentWithoutCanonicalSchemaId(path: string, content: string): string {
  const allowed = CANONICAL_GRIMNIR_SCHEMA_IDS.get(path);
  if (!allowed) return content;
  const exactIdLine = `  "$id": ${JSON.stringify(allowed)},`;
  const lines = content.split("\n");
  const matches = lines.filter((line) => line === exactIdLine).length;
  return matches === 1 ? lines.filter((line) => line !== exactIdLine).join("\n") : content;
}

/**
 * RFC 6598 shared address space (100.64.0.0/10) — the range Tailscale allocates
 * from. Any literal from this range is presumed to be a real node address unless
 * it is one of the explicitly synthetic values below.
 */
const CGNAT_LITERAL = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;

/**
 * Addresses that are safe because they are obviously synthetic and are used to
 * exercise CGNAT-range behaviour. Extending this set is a deliberate decision:
 * add a value here only when it is invented, never because a real one broke CI.
 */
const SYNTHETIC_CGNAT = new Set(["100.64.0.0", "100.64.0.10", "100.64.1.2"]);

describe("public repository host identifiers", () => {
  it("contains no reference to the owner's private inference domain", () => {
    const offenders: string[] = [];

    for (const path of trackedFiles()) {
      if (path === "tests/public-host-identifiers.test.ts") continue;
      const content = readTracked(path);
      if (content === null) continue;
      if (PRIVATE_DOMAIN.test(contentWithoutCanonicalSchemaId(path, content))) offenders.push(path);
      PRIVATE_DOMAIN.lastIndex = 0;
    }

    expect(
      offenders,
      `Private domain found in tracked files. Public docs/examples must use ` +
        `inference.example.com:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("permits only the exact canonical Grimnir schema authority in its pinned schema path", () => {
    const path = "contracts/grimnir-autonomy-v1/schemas/journal.schema.json";
    const allowed = CANONICAL_GRIMNIR_SCHEMA_IDS.get(path)!;
    expect(contentWithoutCanonicalSchemaId(path, `{\n  "$id": ${JSON.stringify(allowed)},\n}`)).not.toMatch(PRIVATE_DOMAIN);
    PRIVATE_DOMAIN.lastIndex = 0;
    expect(contentWithoutCanonicalSchemaId(path, `{\n  "$id": "https://grimnir.gille.ai/other",\n}`)).toMatch(PRIVATE_DOMAIN);
    PRIVATE_DOMAIN.lastIndex = 0;
    expect(contentWithoutCanonicalSchemaId("docs/example.md", allowed)).toMatch(PRIVATE_DOMAIN);
    PRIVATE_DOMAIN.lastIndex = 0;

    const v2Path = "contracts/grimnir-autonomy-v2/schemas/journal.schema.json";
    const allowedV2 = CANONICAL_GRIMNIR_SCHEMA_IDS.get(v2Path)!;
    expect(contentWithoutCanonicalSchemaId(v2Path, `{\n  "$id": ${JSON.stringify(allowedV2)},\n}`)).not.toMatch(PRIVATE_DOMAIN);
    PRIVATE_DOMAIN.lastIndex = 0;
    expect(contentWithoutCanonicalSchemaId(v2Path, `{\n  "$id": "https://grimnir.gille.ai/other",\n}`)).toMatch(PRIVATE_DOMAIN);
    PRIVATE_DOMAIN.lastIndex = 0;
  });

  it("contains no real tailnet (CGNAT) address", () => {
    const offenders: string[] = [];

    for (const path of trackedFiles()) {
      if (path === "tests/public-host-identifiers.test.ts") continue;
      const content = readTracked(path);
      if (content === null) continue;

      for (const match of content.matchAll(CGNAT_LITERAL)) {
        const value = match[0];
        if (SYNTHETIC_CGNAT.has(value)) continue;
        offenders.push(`${path}: ${value}`);
      }
    }

    expect(
      offenders,
      `Address(es) in the Tailscale CGNAT range 100.64.0.0/10 found in tracked ` +
        `files. Use a synthetic address from SYNTHETIC_CGNAT instead of a real ` +
        `node address:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("keeps owner-private working documents untracked", () => {
    // These four files were deliberately dropped by the publication scrub. Two were
    // protected by .gitignore; the build journal and infra analysis were not, so a
    // routine `git add docs/` could have republished them.
    const mustStayUntracked = [
      "STATUS.md",
      "deep-research.md",
      "docs/m5-build-journal.md",
      "docs/holistic-infra-analysis-2026-06-16.md",
    ];

    const tracked = new Set(trackedFiles());
    const republished = mustStayUntracked.filter((p) => tracked.has(p));

    expect(
      republished,
      `Owner-private document(s) are tracked in the public repository:\n  ` +
        republished.join("\n  ")
    ).toEqual([]);
  });
});
