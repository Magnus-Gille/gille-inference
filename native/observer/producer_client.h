#ifndef GI_PRODUCER_CLIENT_H
#define GI_PRODUCER_CLIENT_H
#include "producer_receipt.h"
#include <stdint.h>

/* Internal trusted collector input, never an IPC/request schema. The complete
 * observer must derive this binding from its accepted manifest and live service
 * inventory, including executable/configuration and invocation verification. */
struct gi_proxy_binding {
    uint32_t uid;
    uint32_t pid;
    uint64_t start_ticks;
    char instance_sha256[65];
    char build_sha256[65];
    char config_sha256[65];
};

enum gi_producer_result {
    GI_PRODUCER_OK = 0,
    GI_PRODUCER_INVALID_BINDING = -1,
    GI_PRODUCER_UNAVAILABLE = -2,
    GI_PRODUCER_IDENTITY_CHANGED = -3,
    GI_PRODUCER_INVALID_RECEIPT = -4,
    GI_PRODUCER_EXPIRED = -5
};

/* Only /run/llama-swap-observer/activity.sock. Fresh random nonce, kernel peer
 * credentials and process start ticks are checked. No retry or arbitrary path.
 * A valid unknown receipt returns OK with known=false: never treat it as idle.
 * Any failure clears the complete output. This is not an admission decision. */
int gi_observe_proxy_activity(const struct gi_proxy_binding *binding,
                             struct gi_producer_receipt *out);
/* Runtime channel: validated ASCII producer ID (1..64 [A-Za-z0-9_-]) from
 * the trusted collector binding, never an arbitrary caller-controlled path.
 * Uses /run/gille-producer-observer-<id>/activity.sock and the same checks.
 * The name does not attest that a runtime is instrumented or accepted. */
int gi_observe_runtime_activity(const struct gi_proxy_binding *binding,
                               const char *producer_id, struct gi_producer_receipt *out);
#endif
