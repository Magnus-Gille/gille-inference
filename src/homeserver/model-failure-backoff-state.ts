import { getTrustedCatalogue } from "./catalogue.js";
import { ModelFailureBackoff } from "./model-failure-backoff.js";

// The admission controller is the gateway-instance identity. A failing caller must
// never suppress another caller's model access, including owner-priority traffic.
const gateways = new WeakMap<object, Map<string, { roster: string; backoff: ModelFailureBackoff }>>();
const MAX_CALLERS = 256;

export function modelFailureBackoffFor(
  gateway: object,
  principal: { alias: string; keyHash: string | null },
  configuredModels: readonly string[] = [],
): ModelFailureBackoff {
  // Legacy/static identities share aliases and quota buckets. They cannot safely
  // identify an individual key for this guard, so retain their existing policy.
  if (principal.keyHash === null) return new ModelFailureBackoff([]);
  let callers = gateways.get(gateway);
  if (callers === undefined) {
    callers = new Map();
    gateways.set(gateway, callers);
  }
  const ids = [...new Set([...getTrustedCatalogue(), ...configuredModels])].filter((id) => id !== "unknown" && id !== "none").sort();
  const roster = JSON.stringify(ids);
  // Dedicated configured decision-model state cannot be cleared by switching to chat/MCP.
  const key = `${principal.keyHash}${configuredModels.length ? ":configured" : ""}`;
  const existing = callers.get(key);
  if (existing?.roster === roster) {
    callers.delete(key);
    callers.set(key, existing);
    return existing.backoff;
  }
  const backoff = new ModelFailureBackoff(ids);
  callers.delete(key);
  if (callers.size >= MAX_CALLERS) callers.delete(callers.keys().next().value!);
  callers.set(key, { roster, backoff });
  return backoff;
}
