/** Offline G1 review material only. Neither a signature nor an execution/approval API. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { jcsCanonicalize } from "./learning-task-contract.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const unit = z.string().regex(/^[a-zA-Z0-9_.@-]+\.service$/).max(128);
const count = z.number().int().nonnegative().safe();
const absolutePath = z.string().max(512).regex(/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/);
const artifact = z.object({
  file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.[a-zA-Z0-9]+$/).max(128),
  sha256: digest, bytes: count.min(1).max(64 * 1024 * 1024),
}).strict();
const roles = ["observer", "unit", "apparmor", "busPolicy", "polkitPolicy", "hostManifest",
  "buildProvenance", "linuxQualification", "operations", "rollback"] as const;
const artifactShape = Object.fromEntries(roles.map(role => [role, artifact])) as Record<typeof roles[number], typeof artifact>;
const stoppingConditions = ["scope-change", "weaker-safeguards", "expired", "production-or-credential-access",
  "oom", "protected-state-change", "stop-failure", "restoration-failure"] as const;

/** A dossier for review, deliberately narrower than the later executable host packet. */
export const observerReviewPacketSchema = z.object({
  schemaVersion: z.literal(1), gate: z.literal("G1"), goal: z.literal("qualify-read-only-observer"),
  host: id, hostBootIdSha256: digest, releaseSha: sha,
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  artifacts: z.object(artifactShape).strict(),
  target: z.object({
    unitPrefix: z.string().regex(/^gille-observer-eval-[a-z0-9-]+-$/).max(80),
    unit: unit, profile: id, observerPath: absolutePath, unitPath: absolutePath,
    apparmorPath: absolutePath, busPolicyPath: absolutePath, polkitPolicyPath: absolutePath,
    outputDirectory: absolutePath,
    existingIdentity: z.object({ name: id, uid: count.min(1), gid: count.min(1) }).strict(),
    pathsMustBeAbsent: z.literal(true), provisionIdentity: z.literal(false),
  }).strict(),
  privileges: z.object({
    capabilities: z.array(z.enum(["CAP_SYS_PTRACE", "CAP_DAC_READ_SEARCH"])).max(2),
    apparmor: z.literal("enforce"), systemBus: z.literal("method-filtered-read-only"),
    polkit: z.literal("explicit-deny"), hostPidAndNetworkVisibility: z.literal(true),
    ipNetwork: z.literal(false), subprocess: z.literal(false), ptrace: z.literal(false),
    processMemory: z.literal(false), secretReads: z.literal(false),
  }).strict(),
  limits: z.object({
    memoryMaxBytes: count.min(1).max(128 * 1024 * 1024), memorySwapMaxBytes: z.literal(0),
    cpuQuotaPercent: count.min(1).max(25), tasksMax: count.min(1).max(32),
    windowMs: count.min(1).max(20 * 60 * 1000), maxRuns: z.literal(1),
    outputMaxBytes: count.min(1).max(64 * 1024 * 1024),
    stopTimeoutMs: count.min(1).max(2000), cleanupTimeoutMs: count.min(1).max(15000),
    restorationTimeoutMs: count.min(1).max(15000),
  }).strict(),
  priorState: z.object({
    gatewayReleaseSha: sha, maintenanceActive: z.literal(false),
    residentModelIds: z.array(id).max(128),
    services: z.array(z.object({
      unit, invocationIdSha256: digest, executableSha256: digest, configSha256: digest,
      active: z.literal(true), oomKills: count,
    }).strict()).min(1).max(128),
  }).strict(),
  safeguards: z.object({
    allowedMutation: z.literal("create-and-remove-only-named-observer-artifacts"),
    maintenance: z.literal("exclude-through-restoration"),
    cleanup: z.literal("owned-paths-only-after-proven-stop"),
    restoration: z.literal("protected-state-and-oom-unchanged"),
    productionChanges: z.literal(false), inferenceRequests: z.literal(false),
    inferenceRestarts: z.literal(false), credentialChanges: z.literal(false),
    automaticRetryAfterMutation: z.literal(false),
    reconfirmOn: z.tuple(stoppingConditions.map(value => z.literal(value)) as [z.ZodLiteral<typeof stoppingConditions[number]>, ...z.ZodLiteral<typeof stoppingConditions[number]>[]]),
  }).strict(),
}).strict().superRefine((p, ctx) => {
  const fail = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent packet" });
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(p.privileges.capabilities)) fail();
  if (!p.target.unit.startsWith(p.target.unitPrefix) ||
      p.target.unitPath !== `/etc/systemd/system/${p.target.unit}` ||
      p.target.apparmorPath !== `/etc/apparmor.d/${p.target.profile}`) fail();
  const paths = [p.target.observerPath, p.target.unitPath, p.target.apparmorPath,
    p.target.busPolicyPath, p.target.polkitPolicyPath, p.target.outputDirectory];
  if (!unique(paths) || paths.some((a, i) => paths.some((b, j) => i !== j && a.startsWith(`${b}/`)))) fail();
  const files = roles.map(role => p.artifacts[role].file.toLowerCase());
  if (!unique(files) || files.includes("packet.json")) fail();
  if (roles.reduce((sum, role) => sum + p.artifacts[role].bytes, 0) > 128 * 1024 * 1024) fail();
  if (!unique(p.priorState.residentModelIds) || !unique(p.priorState.services.map(service => service.unit)) ||
      p.priorState.services.some(service => service.unit === p.target.unit)) fail();
  const duration = Date.parse(p.expiresAt) - Date.parse(p.createdAt);
  if (duration <= 0 || duration > p.limits.windowMs) fail();
  if (p.safeguards.reconfirmOn.join("|") !== stoppingConditions.join("|")) fail();
});
export type ObserverReviewPacket = z.infer<typeof observerReviewPacketSchema>;
export interface ObserverBundleReport {
  source: "observer-review-bundle-v1";
  valid: boolean;
  authorizesMutation: false;
  packetSha256: string | null;
  reasons: string[];
}

/** Parses strictly before hashing. The expected hash must arrive independently of bundle bytes. */
export function observerReviewPacketDigest(input: unknown): string {
  return createHash("sha256").update(jcsCanonicalize(observerReviewPacketSchema.parse(input))).digest("hex");
}

/** JSON.parse validates grammar, then this bounded walk rejects duplicate decoded object keys. */
function parseUnambiguousJson(data: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  const parsed: unknown = JSON.parse(text);
  // Grammar is already validated. Keep quoted strings intact, including escaped quotes/braces.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^{}\[\],:\s]+/g) ?? [];
  let index = 0;
  const value = (depth: number): void => {
    if (depth > 32) throw new Error("invalid-json");
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      if (tokens[index] !== "}") {
        while (true) {
          const key: string = JSON.parse(tokens[index++]);
          if (keys.has(key)) throw new Error("invalid-json");
          keys.add(key);
          index++; // colon; JSON.parse has validated the syntax
          value(depth + 1);
          if (tokens[index] !== ",") break;
          index++;
        }
      }
      index++; // closing brace
    } else if (token === "[") {
      if (tokens[index] !== "]") {
        while (true) {
          value(depth + 1);
          if (tokens[index] !== ",") break;
          index++;
        }
      }
      index++; // closing bracket
    }
  };
  value(0);
  if (index !== tokens.length) throw new Error("invalid-json");
  return parsed;
}

const stable = (a: Awaited<ReturnType<typeof fileStat>>, b: Awaited<ReturnType<typeof fileStat>>) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const fileStat = (path: string) => lstat(path, { bigint: true });

/** Flat, bounded, no-follow reads. A hostile concurrently writable filesystem is not a sandbox. */
async function readFileBounded(path: string, maxBytes: number, retain: boolean): Promise<{ bytes: number; sha256: string; data: Buffer }> {
  const before = await fileStat(path);
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new Error("read-rejected");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!stable(before, await handle.stat({ bigint: true }))) throw new Error("read-rejected");
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024));
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - bytes), null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new Error("read-rejected");
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      if (retain) chunks.push(Buffer.from(chunk));
    }
    if (BigInt(bytes) !== before.size || !stable(before, await handle.stat({ bigint: true })) ||
        !stable(before, await fileStat(path))) throw new Error("read-rejected");
    return { bytes, sha256: hash.digest("hex"), data: Buffer.concat(chunks) };
  } finally { await handle.close(); }
}

/** Integrity and schema checking only. Does not interpret policies, prove receipts or contact a host. */
export async function checkObserverReviewBundle(directory: string, expectedDigest: string, nowMs = Date.now()): Promise<ObserverBundleReport> {
  const report: ObserverBundleReport = { source: "observer-review-bundle-v1", valid: false,
    authorizesMutation: false, packetSha256: null, reasons: [] };
  if (!digest.safeParse(expectedDigest).success || !count.safeParse(nowMs).success) {
    report.reasons.push("invalid-check-input"); return report;
  }
  try {
    // Resolve parents once; reject a symlink for the supplied bundle directory itself.
    const inputRoot = await fileStat(directory), root = await realpath(directory), before = await fileStat(root);
    if (!inputRoot.isDirectory() || !before.isDirectory() || !stable(inputRoot, before)) throw new Error("read-rejected");
    const json = await readFileBounded(join(root, "packet.json"), 1024 * 1024, true);
    let packet: ObserverReviewPacket;
    try { packet = observerReviewPacketSchema.parse(parseUnambiguousJson(json.data)); }
    catch { report.reasons.push("invalid-packet"); return report; }
    report.packetSha256 = observerReviewPacketDigest(packet);
    if (report.packetSha256 !== expectedDigest) report.reasons.push("packet-digest-mismatch");
    if (nowMs < Date.parse(packet.createdAt) || nowMs >= Date.parse(packet.expiresAt)) report.reasons.push("packet-outside-window");
    // Do not read paths nominated by an unaccepted or stale packet.
    if (report.reasons.length) return report;
    for (const role of roles) {
      const expected = packet.artifacts[role];
      const actual = await readFileBounded(join(root, expected.file), expected.bytes, false);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        report.reasons.push("artifact-mismatch"); return report;
      }
    }
    if (!stable(before, await fileStat(root)) || !stable(inputRoot, await fileStat(directory))) throw new Error("read-rejected");
    report.valid = true;
  } catch { report.reasons.push("bundle-read-failed"); }
  return report;
}
