#ifndef GI_PRODUCER_RECEIPT_H
#define GI_PRODUCER_RECEIPT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GI_PRODUCER_RECEIPT_MAX_LEN ((size_t)2048U)
#define GI_PRODUCER_RECEIPT_SCHEMA_VERSION 1U
#define GI_PRODUCER_ID_MAX_LEN ((size_t)64U)
#define GI_PRODUCER_SHA256_HEX_LEN ((size_t)64U)

/*
 * Field names use snake_case for C callers and correspond exactly to the
 * producer's camelCase JSON names. The four counters are meaningful only when
 * known is true; a valid receipt containing any null counter clears all four.
 */
struct gi_producer_receipt {
    char producer_id[GI_PRODUCER_ID_MAX_LEN + 1U];
    char instance_sha256[GI_PRODUCER_SHA256_HEX_LEN + 1U];
    char build_sha256[GI_PRODUCER_SHA256_HEX_LEN + 1U];
    char config_sha256[GI_PRODUCER_SHA256_HEX_LEN + 1U];
    char request_nonce_sha256[GI_PRODUCER_SHA256_HEX_LEN + 1U];
    uint64_t active;
    uint64_t queued;
    uint64_t loading;
    uint64_t work_started;
    bool known;
};

/* Returns 0 for one valid receipt, or a negative error after zeroing out. */
int gi_parse_producer_receipt(const char *data, size_t len,
                              struct gi_producer_receipt *out);

#endif
