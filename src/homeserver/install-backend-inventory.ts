import { createHash } from "node:crypto";
import { z } from "zod";

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const idSchema = z.string().regex(ID_PATTERN, "must be a 1-64 character ASCII identifier");

const backendSchema = z.object({
  id: idSchema,
  kind: z.enum(["runtime", "sidecar"]),
  ingressIds: z.array(idSchema).min(1).max(128),
}).strict();

const ingressSchema = z.object({
  id: idSchema,
  kind: z.enum(["gateway", "proxy", "direct", "lifecycle"]),
  backendIds: z.array(idSchema).min(1).max(64),
}).strict();

/**
 * The declared backend/ingress topology used by the controlled installer.
 * This is a pure contract: it does not discover or infer any host capability.
 */
export const installBackendInventorySchema = z.object({
  schemaVersion: z.literal(1),
  hostBootIdSha256: z.string().regex(SHA256_PATTERN, "must be a lowercase 64-character SHA-256 hex string"),
  backends: z.array(backendSchema).min(1).max(64),
  ingresses: z.array(ingressSchema).min(1).max(128),
}).strict().superRefine((inventory, ctx) => {
  const backendIds = new Set<string>();
  const ingressIds = new Set<string>();

  for (const [index, backend] of inventory.backends.entries()) {
    if (backendIds.has(backend.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backends", index, "id"], message: "duplicate global inventory ID" });
    }
    backendIds.add(backend.id);
    if (new Set(backend.ingressIds).size !== backend.ingressIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backends", index, "ingressIds"], message: "duplicate ingress link" });
    }
  }

  for (const [index, ingress] of inventory.ingresses.entries()) {
    if (backendIds.has(ingress.id) || ingressIds.has(ingress.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ingresses", index, "id"], message: "duplicate global inventory ID" });
    }
    ingressIds.add(ingress.id);
    if (new Set(ingress.backendIds).size !== ingress.backendIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ingresses", index, "backendIds"], message: "duplicate backend link" });
    }
  }

  const backendsById = new Map(inventory.backends.map((backend) => [backend.id, backend]));
  const ingressesById = new Map(inventory.ingresses.map((ingress) => [ingress.id, ingress]));

  for (const [backendIndex, backend] of inventory.backends.entries()) {
    let hasDirectIngress = false;
    let hasLifecycleIngress = false;
    for (const ingressId of backend.ingressIds) {
      const ingress = ingressesById.get(ingressId);
      if (!ingress) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backends", backendIndex, "ingressIds"], message: `missing ingress reference: ${ingressId}` });
        continue;
      }
      hasDirectIngress ||= ingress.kind === "direct";
      hasLifecycleIngress ||= ingress.kind === "lifecycle";
      if (!ingress.backendIds.includes(backend.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backends", backendIndex, "ingressIds"], message: `asymmetric ingress link: ${backend.id} -> ${ingressId}` });
      }
    }
    if (!hasDirectIngress) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backends", backendIndex, "ingressIds"], message: "backend requires a direct ingress" });
    }
    if (!hasLifecycleIngress) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backends", backendIndex, "ingressIds"], message: "backend requires a lifecycle ingress" });
    }
  }

  for (const [ingressIndex, ingress] of inventory.ingresses.entries()) {
    for (const backendId of ingress.backendIds) {
      const backend = backendsById.get(backendId);
      if (!backend) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ingresses", ingressIndex, "backendIds"], message: `missing backend reference: ${backendId}` });
        continue;
      }
      if (!backend.ingressIds.includes(ingress.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ingresses", ingressIndex, "backendIds"], message: `asymmetric backend link: ${ingress.id} -> ${backendId}` });
      }
    }
  }
});

export type InstallBackendInventory = z.infer<typeof installBackendInventorySchema>;

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalInventory(inventory: InstallBackendInventory): string {
  // Construct each object in the contract's fixed key order and sort copies so that hashing never
  // mutates either the caller's input or the object returned by Zod.
  const canonical = {
    schemaVersion: inventory.schemaVersion,
    hostBootIdSha256: inventory.hostBootIdSha256,
    backends: inventory.backends
      .slice()
      .sort((left, right) => asciiCompare(left.id, right.id))
      .map((backend) => ({
        id: backend.id,
        kind: backend.kind,
        ingressIds: backend.ingressIds.slice().sort(asciiCompare),
      })),
    ingresses: inventory.ingresses
      .slice()
      .sort((left, right) => asciiCompare(left.id, right.id))
      .map((ingress) => ({
        id: ingress.id,
        kind: ingress.kind,
        backendIds: ingress.backendIds.slice().sort(asciiCompare),
      })),
  };
  return JSON.stringify(canonical);
}

/** Parse and hash an inventory's fixed, order-independent canonical representation. */
export function hashInstallBackendInventory(input: unknown): string {
  const inventory = installBackendInventorySchema.parse(input);
  return createHash("sha256")
    .update(`install-backend-inventory-v1\n${canonicalInventory(inventory)}`, "utf8")
    .digest("hex");
}
