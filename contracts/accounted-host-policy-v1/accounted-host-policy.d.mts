/** Types for the unchanged dependency-free R4 implementation. */
export interface AccountedPolicyDecision {
  schemaVersion: 1;
  laneId: "accounted-podman-info-v1";
  phase: "admission" | "restoration";
  offlineOnly: true;
  executionAuthorized: false;
  admit: boolean;
  inputDigest: string | null;
  reasons: AccountedReasonCode[];
  decisionDigest: string;
}
export type AccountedReasonCode =
  | "activity_unknown" | "allocation_invalid" | "allocation_mismatch" | "baseline_invalid"
  | "baseline_missing" | "binding_mismatch" | "clock_invalid" | "conflicting_evidence"
  | "control_plane_incomplete" | "control_plane_unknown" | "controls_conflict"
  | "coverage_incomplete" | "digest_mismatch" | "expired" | "future_observation"
  | "gpu_access_forbidden" | "lane_mismatch" | "lease_held" | "local_ipc_undefined"
  | "malformed_input" | "maintenance_active" | "maintenance_unknown" | "manifest_invalid"
  | "missing_field" | "observation_stale" | "oom_drift" | "oom_unknown"
  | "payload_ip_network_forbidden" | "protected_identity_drift" | "protected_inventory_drift"
  | "protected_restart_drift" | "protected_service_unhealthy" | "residency_drift"
  | "schema_mismatch" | "unknown_field" | "work_active" | "work_queued";
export const SCHEMA_VERSION: 1;
export const LANE_ID: "accounted-podman-info-v1";
export const REASON_CODES: readonly AccountedReasonCode[];
export function canonicalStringify(value: unknown): string;
export function digestProtectedManifest(value: unknown): string;
export function digestOwnerAllocation(value: unknown): string;
export function digestControlPlaneAccounting(value: unknown): string;
export function digestPolicyInput(value: unknown): string;
export function digestPolicyDecision(value: unknown): string;
export function projectWireCore(bindings: unknown): Record<string, unknown>;
/** `nowMs` is an integer millisecond clock; it cannot express a sub-millisecond now. */
export function evaluateAdmission(input: unknown, nowMs: number): AccountedPolicyDecision;
export function evaluateRestoration(input: unknown, nowMs: number): AccountedPolicyDecision;
export function evaluateAdmissionAtMicros(input: unknown, nowMicros: bigint): AccountedPolicyDecision;
export function evaluateRestorationAtMicros(input: unknown, nowMicros: bigint): AccountedPolicyDecision;
export function evaluateAdmissionAtTimestamp(input: unknown, now: string): AccountedPolicyDecision;
export function evaluateRestorationAtTimestamp(input: unknown, now: string): AccountedPolicyDecision;
