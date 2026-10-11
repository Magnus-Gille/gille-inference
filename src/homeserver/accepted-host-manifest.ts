import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { jcsCanonicalize } from "./learning-task-contract.js";
import { z } from "zod";

/**
 * A strict declarative boundary description. It carries required evidence declarations only;
 * parsing does not authenticate bytes, establish operator acceptance, inspect live state, or prove
 * complete coverage. A future collector must independently verify ownership, modes, ancestors,
 * containment, hashes, and continuity (including positive kernel metadata for kernel threads).
 */

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const pathPattern = /^\/(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/;
const serviceUnitPattern = /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?\.service$/;
const activationUnitPattern = /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?\.(?:service|socket|timer|path)$/;

const idSchema = z.string().regex(idPattern);
const digestSchema = z.string().regex(digestPattern);
const absolutePathSchema = z.string().max(512).regex(pathPattern).refine(
  (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
  { message: "paths must not contain dot segments" },
);
const serviceUnitSchema = z.string().max(128).regex(serviceUnitPattern).refine(
  (value) => value !== "@.service",
  { message: "bare templated service units are not accepted" },
);
const activationUnitSchema = z.string().max(128).regex(activationUnitPattern).refine(
  (value) => value !== "@.service",
  { message: "bare templated service units are not accepted" },
);
const uidSchema = z.number().int().min(0).max(4_294_967_294);

function canonicalizeAddress(value: string): string {
  const version = isIP(value);
  if (version === 0 || value.includes("%")) {
    throw new Error("listener addresses must be literal IP addresses without scopes");
  }
  try {
    if (version === 6) {
      const hostname = new URL(`http://[${value}]/`).hostname;
      if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
        throw new Error("invalid IPv6 address");
      }
      return hostname.slice(1, -1);
    }
    return new URL(`http://${value}/`).hostname;
  } catch {
    throw new Error("listener address is not a canonical literal IP address");
  }
}

const roleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("producer"), producerId: idSchema }).strict(),
  z.object({ kind: z.literal("excluded"), reason: z.literal("reviewed-non-inference") }).strict(),
  z.object({
    kind: z.literal("owned"),
    purpose: z.enum(["observer", "launcher", "installation"]),
    runIdSha256: digestSchema,
  }).strict(),
]);

const processSchema = z.object({
  id: idSchema,
  unit: serviceUnitSchema,
  uid: uidSchema,
  cgroup: absolutePathSchema,
  executable: z.object({ path: absolutePathSchema, sha256: digestSchema }).strict(),
  configSha256: digestSchema,
  unitDefinitionSha256: digestSchema,
  containmentSha256: digestSchema,
  reviewSha256: digestSchema,
  control: z.enum(["root-owned-nonwritable", "identity-checked"]),
  role: roleSchema,
}).strict();

const listenerAddressSchema = z.string().max(45).superRefine((value, ctx) => {
  try {
    canonicalizeAddress(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "invalid IP address" });
  }
}).transform(canonicalizeAddress);

const listenerSchema = z.discriminatedUnion("transport", [
  z.object({
    id: idSchema,
    processId: idSchema,
    transport: z.literal("tcp"),
    address: listenerAddressSchema,
    port: z.number().int().min(1).max(65_535),
  }).strict(),
  z.object({
    id: idSchema,
    processId: idSchema,
    transport: z.literal("udp"),
    address: listenerAddressSchema,
    port: z.number().int().min(1).max(65_535),
  }).strict(),
  z.object({
    id: idSchema,
    processId: idSchema,
    transport: z.literal("unix"),
    path: absolutePathSchema,
  }).strict(),
]);

const activationSchema = z.object({
  id: idSchema,
  unit: activationUnitSchema,
  definitionSha256: digestSchema,
  kind: z.enum(["manual-unit", "socket", "timer", "path", "preload", "load", "unload", "replacement"]),
  targetProcessIds: z.array(idSchema).min(1).max(4_096),
}).strict();

const baseAcceptedHostManifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("accepted-host-manifest-v1"),
  hostId: idSchema,
  hostBootIdSha256: digestSchema,
  namespaces: z.object({
    pidSha256: digestSchema,
    networkSha256: digestSchema,
    userSha256: digestSchema,
    mountSha256: digestSchema,
  }).strict(),
  processes: z.array(processSchema).min(1).max(4_096),
  listeners: z.array(listenerSchema).max(4_096),
  activations: z.array(activationSchema).max(4_096),
}).strict();

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function endpointKey(listener: AcceptedHostManifest["listeners"][number]): string {
  return listener.transport === "unix"
    ? `unix\u0000${listener.path}`
    : `${listener.transport}\u0000${listener.address}\u0000${listener.port}`;
}

export const acceptedHostManifestSchema = baseAcceptedHostManifestSchema.superRefine((manifest, ctx) => {
  const processIds = new Set<string>();
  const globalIds = new Set<string>();
  const processTuples = new Set<string>();
  const producerIds = new Set<string>();
  const ownedPurposes = new Set<string>();
  let producerCount = 0;

  for (const [index, process] of manifest.processes.entries()) {
    if (processIds.has(process.id)) addIssue(ctx, ["processes", index, "id"], "process IDs must be unique");
    processIds.add(process.id);
    if (globalIds.has(process.id)) addIssue(ctx, ["processes", index, "id"], "IDs must be globally unique");
    globalIds.add(process.id);

    const tuple = JSON.stringify([process.unit, process.uid, process.cgroup, process.executable.path]);
    if (processTuples.has(tuple)) {
      addIssue(ctx, ["processes", index], "process unit/UID/cgroup/executable path tuple must be unique");
    }
    processTuples.add(tuple);

    if (process.role.kind === "producer") {
      producerCount += 1;
      if (producerIds.has(process.role.producerId)) {
        addIssue(ctx, ["processes", index, "role", "producerId"], "producer IDs must be unique");
      }
      producerIds.add(process.role.producerId);
    }
    if (process.role.kind === "owned") {
      if (process.control !== "root-owned-nonwritable") {
        addIssue(ctx, ["processes", index, "control"], "owned processes require root-owned-nonwritable control");
      }
      if (ownedPurposes.has(process.role.purpose)) {
        addIssue(ctx, ["processes", index, "role", "purpose"], "owned purposes must be unique");
      }
      ownedPurposes.add(process.role.purpose);
    }
    if (process.role.kind === "excluded" && process.control !== "root-owned-nonwritable") {
      addIssue(ctx, ["processes", index, "control"], "excluded processes require root-owned-nonwritable control");
    }
  }
  if (producerCount === 0) addIssue(ctx, ["processes"], "at least one producer process is required");

  const listenerEndpoints = new Set<string>();
  for (const [index, listener] of manifest.listeners.entries()) {
    if (!processIds.has(listener.processId)) {
      addIssue(ctx, ["listeners", index, "processId"], "listener processId must reference a process");
    }
    if (globalIds.has(listener.id)) addIssue(ctx, ["listeners", index, "id"], "IDs must be globally unique");
    globalIds.add(listener.id);
    const endpoint = endpointKey(listener);
    if (listenerEndpoints.has(endpoint)) addIssue(ctx, ["listeners", index], "listener endpoints must be unique");
    listenerEndpoints.add(endpoint);
  }

  const activatedProcessIds = new Set<string>();
  const activationUnits = new Set<string>();
  let targetReferenceCount = 0;
  for (const [index, activation] of manifest.activations.entries()) {
    if (globalIds.has(activation.id)) addIssue(ctx, ["activations", index, "id"], "IDs must be globally unique");
    globalIds.add(activation.id);
    const activationUnitKey = `${activation.kind}\u0000${activation.unit}`;
    if (activationUnits.has(activationUnitKey)) {
      addIssue(ctx, ["activations", index], "activation unit must be unique per kind");
    }
    activationUnits.add(activationUnitKey);

    const expectedSuffix = activation.kind === "socket"
      ? ".socket"
      : activation.kind === "timer"
        ? ".timer"
        : activation.kind === "path"
          ? ".path"
          : ".service";
    if (!activation.unit.endsWith(expectedSuffix)) {
      addIssue(ctx, ["activations", index, "unit"], `activation kind requires ${expectedSuffix} unit`);
    }

    const targetIds = new Set<string>();
    for (const [targetIndex, processId] of activation.targetProcessIds.entries()) {
      targetReferenceCount += 1;
      if (targetIds.has(processId)) {
        addIssue(ctx, ["activations", index, "targetProcessIds", targetIndex], "activation target IDs must be unique");
      }
      targetIds.add(processId);
      if (!processIds.has(processId)) {
        addIssue(ctx, ["activations", index, "targetProcessIds", targetIndex], "activation target must reference a process");
      }
      activatedProcessIds.add(processId);
    }
  }
  if (targetReferenceCount > 16_384) {
    addIssue(ctx, ["activations"], "total activation target references must not exceed 16384");
  }
  for (const processId of processIds) {
    if (!activatedProcessIds.has(processId)) {
      addIssue(ctx, ["processes"], `process ${processId} must appear in an activation target`);
    }
  }
});

export type AcceptedHostManifest = z.infer<typeof acceptedHostManifestSchema>;

function sortedManifest(manifest: AcceptedHostManifest): AcceptedHostManifest {
  const asciiIdOrder = <T extends { id: string }>(left: T, right: T): number => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  return {
    ...manifest,
    processes: manifest.processes
      .map((process) => ({ ...process, executable: { ...process.executable }, role: { ...process.role } }))
      .sort(asciiIdOrder),
    listeners: manifest.listeners
      .map((listener) => ({ ...listener }))
      .sort(asciiIdOrder),
    activations: manifest.activations
      .map((activation) => ({ ...activation, targetProcessIds: [...activation.targetProcessIds].sort() }))
      .sort(asciiIdOrder),
  };
}

export function hashAcceptedHostManifest(input: unknown): string {
  const manifest = acceptedHostManifestSchema.parse(input);
  return createHash("sha256")
    .update(`accepted-host-manifest-v1\n${jcsCanonicalize(sortedManifest(manifest))}`, "utf8")
    .digest("hex");
}
