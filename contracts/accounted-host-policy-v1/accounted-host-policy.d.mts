/** Types for the unchanged dependency-free R4 implementation. */
export interface AccountedPolicyDecision {
  schemaVersion: 1;
  laneId: "accounted-podman-info-v1";
  phase: "admission" | "restoration";
  offlineOnly: true;
  executionAuthorized: false;
  admit: boolean;
  inputDigest: string | null;
  reasons: string[];
  decisionDigest: string;
}
export function canonicalStringify(value: unknown): string;
export function digestProtectedManifest(value: unknown): string;
export function digestOwnerAllocation(value: unknown): string;
export function digestControlPlaneAccounting(value: unknown): string;
export function digestPolicyDecision(value: unknown): string;
export function projectWireCore(bindings: unknown): Record<string, unknown>;
export function evaluateAdmissionAtTimestamp(input: unknown, now: string): AccountedPolicyDecision;
export function evaluateRestorationAtTimestamp(input: unknown, now: string): AccountedPolicyDecision;
