export type BackendFailureReason = "upstream_connection_failed" | "upstream_timeout";

export interface BackendFailureDescriptor {
  readonly reason: BackendFailureReason;
  readonly message: string;
}

export const BACKEND_FAILURE_DESCRIPTORS: Readonly<{
  readonly upstream_connection_failed: BackendFailureDescriptor;
  readonly upstream_timeout: BackendFailureDescriptor;
}>;

export function getBackendFailureDescriptor(reason: unknown): BackendFailureDescriptor | undefined;
