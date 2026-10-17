#include "producer_receipt.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition)                                                        \
    do {                                                                        \
        if (!(condition)) {                                                     \
            fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__,        \
                    __LINE__, #condition);                                     \
            return 1;                                                           \
        }                                                                       \
    } while (0)

static const char valid_receipt[] =
    "{\"schemaVersion\":1,\"producerId\":\"llama_swap\","
    "\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
    "\"buildSha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
    "\"configSha256\":\"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\","
    "\"requestNonceSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"active\":2,\"queued\":3,\"loading\":4,\"workStarted\":5}";

static const char reordered_receipt[] =
    "{\"workStarted\":5,\"configSha256\":\"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\","
    "\"active\":2,\"requestNonceSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"producerId\":\"llama_swap\",\"loading\":4,\"schemaVersion\":1,\"queued\":3,"
    "\"buildSha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
    "\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}";

static const char all_null_receipt[] =
    "{\"schemaVersion\":1,\"producerId\":\"llama_swap\","
    "\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
    "\"buildSha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
    "\"configSha256\":\"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\","
    "\"requestNonceSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"active\":null,\"queued\":null,\"loading\":null,\"workStarted\":null}";

static struct gi_producer_receipt zero_receipt(void)
{
    struct gi_producer_receipt result;

    (void)memset(&result, 0, sizeof(result));
    return result;
}

static int parse(const char *data, size_t len, struct gi_producer_receipt *out)
{
    return gi_parse_producer_receipt(data, len, out);
}

static int test_valid_receipts(void)
{
    struct gi_producer_receipt actual = zero_receipt();
    const struct gi_producer_receipt expected = {
        .producer_id = "llama_swap",
        .instance_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        .build_sha256 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        .config_sha256 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        .request_nonce_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .active = 2U,
        .queued = 3U,
        .loading = 4U,
        .work_started = 5U,
        .known = true,
    };

    CHECK(parse(valid_receipt, sizeof(valid_receipt) - 1U, &actual) == 0);
    CHECK(memcmp(&actual, &expected, sizeof(actual)) == 0);
    actual = zero_receipt();
    CHECK(parse(reordered_receipt, sizeof(reordered_receipt) - 1U, &actual) == 0);
    CHECK(memcmp(&actual, &expected, sizeof(actual)) == 0);
    return 0;
}

static int test_unknown_counts(void)
{
    struct gi_producer_receipt actual;
    const struct gi_producer_receipt expected = {
        .producer_id = "llama_swap",
        .instance_sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        .build_sha256 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        .config_sha256 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        .request_nonce_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .known = false,
    };
    const char mixed[] =
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\","
        "\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"buildSha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
        "\"configSha256\":\"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\","
        "\"requestNonceSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
        "\"active\":null,\"queued\":3,\"loading\":4,\"workStarted\":5}";

    actual = zero_receipt();
    CHECK(parse(all_null_receipt, sizeof(all_null_receipt) - 1U, &actual) == 0);
    CHECK(memcmp(&actual, &expected, sizeof(actual)) == 0);
    actual = zero_receipt();
    CHECK(parse(mixed, sizeof(mixed) - 1U, &actual) == 0);
    CHECK(memcmp(&actual, &expected, sizeof(actual)) == 0);
    return 0;
}

static int test_boundaries_and_rejections(void)
{
    static const char *const malformed[] = {
        "",
        " ",
        "[]",
        "{}",
        "{\"schemaVersion\"",
        "{\"schemaVersion\":",
        "{\"schemaVersion\":1",
        "{\"schemaVersion\":1,}",
        "{\"schemaVersion\":1,\"producerId\":null}",
        "{\"schemaVersion\":true}",
        "{\"schemaVersion\":01}",
        "{\"schemaVersion\":1.0}",
        "{\"schemaVersion\":1e0}",
        "{\"schemaVersion\":-1}",
        "{\"schemaVersion\":+1}",
        "{\"schemaVersion\":1,\"unknown\":0}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"producerId\":\"llama_swap\"}",
        "{\"schema\\u0056ersion\":1}",
        "{\"schemaVersion\":1,\"producerId\":\"llama\\_swap\"}",
        "{\"schemaVersion\":1,\"producerId\":\"\"}",
        "{\"schemaVersion\":1,\"producerId\":\"llama swap\"}",
        "{\"schemaVersion\":1,\"active\":null}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"instanceSha256\":\"0123\"}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"instanceSha256\":null}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeG\"}",
        "{\"schemaVersion\":1,\"producerId\":{}}",
        "{\"schemaVersion\":1,\"producerId\":[\"llama_swap\"]}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":-1}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":+1}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":01}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":1.0}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":1e0}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":true}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":{}},",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":9007199254740992}",
        "{\"schemaVersion\":1,\"producerId\":\"llama_swap\",\"active\":null,\"queued\":null,\"loading\":null,\"workStarted\":null} trailing",
    };
    size_t index;

    for (index = 0U; index < sizeof(malformed) / sizeof(malformed[0]); ++index) {
        struct gi_producer_receipt actual;
        const struct gi_producer_receipt sentinel = {
            .producer_id = "sentinel",
            .active = UINT64_C(99),
            .known = true,
        };

        actual = sentinel;
        CHECK(parse(malformed[index], strlen(malformed[index]), &actual) == -1);
        CHECK(memcmp(&actual, &(struct gi_producer_receipt){ 0 }, sizeof(actual)) == 0);
    }
    return 0;
}

static int test_numeric_and_length_limits(void)
{
    static const char safe_max[] =
        "{\"schemaVersion\":1,\"producerId\":\"A0_-\","
        "\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"buildSha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
        "\"configSha256\":\"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\","
        "\"requestNonceSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
        "\"active\":9007199254740991,\"queued\":0,\"loading\":0,\"workStarted\":0}";
    static const char too_long_id[] =
        "{\"schemaVersion\":1,\"producerId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
        "\"instanceSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"buildSha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
        "\"configSha256\":\"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\","
        "\"requestNonceSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
        "\"active\":0,\"queued\":0,\"loading\":0,\"workStarted\":0}";
    struct gi_producer_receipt actual;
    char exact_max[GI_PRODUCER_RECEIPT_MAX_LEN];
    char embedded_nul[sizeof(valid_receipt)];
    char oversized[GI_PRODUCER_RECEIPT_MAX_LEN + 1U];
    size_t valid_len = sizeof(valid_receipt) - 1U;

    actual = zero_receipt();
    CHECK(parse(safe_max, sizeof(safe_max) - 1U, &actual) == 0);
    CHECK(actual.known && actual.active == UINT64_C(9007199254740991));
    CHECK(parse(too_long_id, sizeof(too_long_id) - 1U, &actual) == -1);

    (void)memcpy(exact_max, valid_receipt, valid_len);
    (void)memset(exact_max + valid_len, ' ', sizeof(exact_max) - valid_len);
    CHECK(parse(exact_max, sizeof(exact_max), &actual) == 0);
    (void)memcpy(embedded_nul, valid_receipt, sizeof(embedded_nul));
    embedded_nul[valid_len / 2U] = '\0';
    CHECK(parse(embedded_nul, valid_len, &actual) == -1);
    (void)memset(oversized, ' ', sizeof(oversized));
    CHECK(parse(oversized, sizeof(oversized), &actual) == -1);
    CHECK(parse("\v", 1U, &actual) == -1);
    CHECK(parse(NULL, 0U, &actual) == -1);
    CHECK(parse(valid_receipt, valid_len, NULL) == -1);
    return 0;
}


/* Complete receipts ensure rejection exercises the changed field, not missing keys. */
static int test_complete_mutations(void)
{
    static const char *const keys[] = { "active", "queued", "loading", "workStarted" };
    static const char *const values[] = { "9007199254740991", "9007199254740992", "01", "1e0", "null" };
    char buffer[2049];
    struct gi_producer_receipt actual;
    for (size_t i = 0; i < 4; ++i) {
        char marker[32];
        snprintf(marker, sizeof marker, "\"%s\":", keys[i]);
        const char *value = strstr(valid_receipt, marker) + strlen(marker);
        for (size_t j = 0; j < 5; ++j) {
            snprintf(buffer, sizeof buffer, "%.*s%s%s", (int)(value - valid_receipt),
                     valid_receipt, values[j], value + 1);
            memset(&actual, 0xa5, sizeof actual);
            int result = parse(buffer, strlen(buffer), &actual);
            if (j == 0) CHECK(result == 0 && actual.known);
            else if (j == 4) CHECK(result == 0 && !actual.known && actual.active == 0 &&
                                  actual.queued == 0 && actual.loading == 0 && actual.work_started == 0);
            else CHECK(result == -1 && memcmp(&actual, &(struct gi_producer_receipt){0}, sizeof actual) == 0);
        }
    }
    static const char *const hashes[] = { "instanceSha256", "buildSha256", "configSha256", "requestNonceSha256" };
    for (size_t i = 0; i < 4; ++i) {
        strcpy(buffer, valid_receipt);
        char marker[40];
        snprintf(marker, sizeof marker, "\"%s\":\"", hashes[i]);
        char *value = strstr(buffer, marker) + strlen(marker);
        value[63] = 'G';
        memset(&actual, 0xa5, sizeof actual);
        CHECK(parse(buffer, strlen(buffer), &actual) == -1);
        CHECK(memcmp(&actual, &(struct gi_producer_receipt){0}, sizeof actual) == 0);
    }
    snprintf(buffer, sizeof buffer, "%s trailing", valid_receipt);
    memset(&actual, 0xa5, sizeof actual);
    CHECK(parse(buffer, strlen(buffer), &actual) == -1);
    CHECK(memcmp(&actual, &(struct gi_producer_receipt){0}, sizeof actual) == 0);
    const char *id = strstr(valid_receipt, "llama_swap");
    char maximum_id[65];
    memset(maximum_id, 'a', 64); maximum_id[64] = '\0';
    snprintf(buffer, sizeof buffer, "%.*s%s%s", (int)(id - valid_receipt), valid_receipt, maximum_id, id + 10);
    CHECK(parse(buffer, strlen(buffer), &actual) == 0 && strlen(actual.producer_id) == 64);
    return 0;
}

int main(void)
{
    CHECK(test_complete_mutations() == 0);
    CHECK(test_valid_receipts() == 0);
    CHECK(test_unknown_counts() == 0);
    CHECK(test_boundaries_and_rejections() == 0);
    CHECK(test_numeric_and_length_limits() == 0);
    puts("all producer receipt parser tests passed");
    return 0;
}
