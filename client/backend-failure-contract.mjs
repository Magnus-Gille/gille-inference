/**
 * The small, sanitized backend-failure contract shared by the gateway and standalone client.
 * Keep the descriptors immutable: the gateway is a trusted producer, while clients use the
 * closed lookup below when handling untrusted metadata.
 */
export const BACKEND_FAILURE_DESCRIPTORS = Object.freeze({
  upstream_connection_failed: Object.freeze({
    reason: "upstream_connection_failed",
    message: "The model backend is unavailable — please retry shortly.",
  }),
  upstream_timeout: Object.freeze({
    reason: "upstream_timeout",
    message: "The model backend timed out (it may be loading a model) — please retry in a few seconds.",
  }),
});

const BACKEND_FAILURE_BY_REASON = new Map(
  Object.values(BACKEND_FAILURE_DESCRIPTORS).map((descriptor) => [descriptor.reason, descriptor]),
);

/**
 * Return a known descriptor for an untrusted metadata reason, or undefined for every unknown
 * value. The private Map keeps lookup closed and non-coercing (including for __proto__ and
 * constructor-shaped inputs).
 */
export function getBackendFailureDescriptor(reason) {
  return BACKEND_FAILURE_BY_REASON.get(reason);
}
