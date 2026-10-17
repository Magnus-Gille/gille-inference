#include "producer_receipt.h"

#include <string.h>

enum gi_receipt_field {
    GI_FIELD_SCHEMA_VERSION = 0,
    GI_FIELD_PRODUCER_ID,
    GI_FIELD_INSTANCE_SHA256,
    GI_FIELD_BUILD_SHA256,
    GI_FIELD_CONFIG_SHA256,
    GI_FIELD_REQUEST_NONCE_SHA256,
    GI_FIELD_ACTIVE,
    GI_FIELD_QUEUED,
    GI_FIELD_LOADING,
    GI_FIELD_WORK_STARTED,
    GI_FIELD_COUNT
};

#define GI_RECEIPT_ALL_FIELDS ((uint16_t)((UINT16_C(1) << GI_FIELD_COUNT) - UINT16_C(1)))
#define GI_SAFE_INTEGER_MAX UINT64_C(9007199254740991)

static int gi_is_json_whitespace(unsigned char value)
{
    return value == (unsigned char)' ' || value == (unsigned char)'\t' ||
           value == (unsigned char)'\n' || value == (unsigned char)'\r';
}

static void gi_skip_json_whitespace(const char *data, size_t len, size_t *index)
{
    while (*index < len && gi_is_json_whitespace((unsigned char)data[*index])) {
        ++*index;
    }
}

static int gi_key_is(const char *data, size_t start, size_t end,
                     const char *literal, size_t literal_len)
{
    return end - start == literal_len &&
           memcmp(data + start, literal, literal_len) == 0;
}

static int gi_parse_key(const char *data, size_t len, size_t *index,
                        unsigned int *field)
{
    size_t start;
    size_t end;

    if (*index >= len || data[*index] != '"') {
        return -1;
    }
    ++*index;
    start = *index;
    while (*index < len) {
        unsigned char value = (unsigned char)data[*index];

        if (value == (unsigned char)'"') {
            break;
        }
        if (value == (unsigned char)'\\' || value < 0x20U || value > 0x7fU) {
            return -1;
        }
        ++*index;
    }
    if (*index >= len) {
        return -1;
    }
    end = *index;
    ++*index;
    if (gi_key_is(data, start, end, "schemaVersion", sizeof("schemaVersion") - 1U)) {
        *field = GI_FIELD_SCHEMA_VERSION;
    } else if (gi_key_is(data, start, end, "producerId", sizeof("producerId") - 1U)) {
        *field = GI_FIELD_PRODUCER_ID;
    } else if (gi_key_is(data, start, end, "instanceSha256", sizeof("instanceSha256") - 1U)) {
        *field = GI_FIELD_INSTANCE_SHA256;
    } else if (gi_key_is(data, start, end, "buildSha256", sizeof("buildSha256") - 1U)) {
        *field = GI_FIELD_BUILD_SHA256;
    } else if (gi_key_is(data, start, end, "configSha256", sizeof("configSha256") - 1U)) {
        *field = GI_FIELD_CONFIG_SHA256;
    } else if (gi_key_is(data, start, end, "requestNonceSha256", sizeof("requestNonceSha256") - 1U)) {
        *field = GI_FIELD_REQUEST_NONCE_SHA256;
    } else if (gi_key_is(data, start, end, "active", sizeof("active") - 1U)) {
        *field = GI_FIELD_ACTIVE;
    } else if (gi_key_is(data, start, end, "queued", sizeof("queued") - 1U)) {
        *field = GI_FIELD_QUEUED;
    } else if (gi_key_is(data, start, end, "loading", sizeof("loading") - 1U)) {
        *field = GI_FIELD_LOADING;
    } else if (gi_key_is(data, start, end, "workStarted", sizeof("workStarted") - 1U)) {
        *field = GI_FIELD_WORK_STARTED;
    } else {
        return -1;
    }
    return 0;
}

static int gi_is_producer_id_char(unsigned char value)
{
    return (value >= (unsigned char)'A' && value <= (unsigned char)'Z') ||
           (value >= (unsigned char)'a' && value <= (unsigned char)'z') ||
           (value >= (unsigned char)'0' && value <= (unsigned char)'9') ||
           value == (unsigned char)'_' || value == (unsigned char)'-';
}

static int gi_is_lower_hex(unsigned char value)
{
    return (value >= (unsigned char)'0' && value <= (unsigned char)'9') ||
           (value >= (unsigned char)'a' && value <= (unsigned char)'f');
}

static int gi_parse_plain_string(const char *data, size_t len, size_t *index,
                                 char *destination, size_t capacity,
                                 size_t required_length, int producer_id)
{
    size_t count = 0U;

    if (*index >= len || data[*index] != '"') {
        return -1;
    }
    ++*index;
    while (*index < len) {
        unsigned char value = (unsigned char)data[*index];

        if (value == (unsigned char)'"') {
            break;
        }
        if (value == (unsigned char)'\\' || value < 0x20U || value > 0x7fU ||
            count + 1U >= capacity) {
            return -1;
        }
        if (producer_id ? !gi_is_producer_id_char(value) : !gi_is_lower_hex(value)) {
            return -1;
        }
        destination[count] = (char)value;
        ++count;
        ++*index;
    }
    if (*index >= len || count == 0U ||
        (required_length != 0U && count != required_length) ||
        (producer_id && count > GI_PRODUCER_ID_MAX_LEN)) {
        return -1;
    }
    destination[count] = '\0';
    ++*index;
    return 0;
}

static int gi_parse_uint(const char *data, size_t len, size_t *index,
                         uint64_t maximum, uint64_t *value)
{
    uint64_t parsed = UINT64_C(0);
    size_t count = 0U;

    if (*index >= len || data[*index] < '0' || data[*index] > '9') {
        return -1;
    }
    if (data[*index] == '0') {
        ++*index;
        if (*index < len && data[*index] >= '0' && data[*index] <= '9') {
            return -1;
        }
        *value = UINT64_C(0);
        return 0;
    }
    while (*index < len && data[*index] >= '0' && data[*index] <= '9') {
        uint64_t digit = (uint64_t)((unsigned char)data[*index] -
                                    (unsigned char)'0');

        if (parsed > (maximum - digit) / UINT64_C(10)) {
            return -1;
        }
        parsed = parsed * UINT64_C(10) + digit;
        ++*index;
        ++count;
    }
    if (count == 0U) {
        return -1;
    }
    *value = parsed;
    return 0;
}

static int gi_parse_count(const char *data, size_t len, size_t *index,
                          uint64_t *value, int *is_null)
{
    if (*index + 4U <= len && memcmp(data + *index, "null", 4U) == 0) {
        *index += 4U;
        *value = UINT64_C(0);
        *is_null = 1;
        return 0;
    }
    *is_null = 0;
    return gi_parse_uint(data, len, index, GI_SAFE_INTEGER_MAX, value);
}

int gi_parse_producer_receipt(const char *data, size_t len,
                              struct gi_producer_receipt *out)
{
    struct gi_producer_receipt parsed;
    size_t index = 0U;
    unsigned int field_count = 0U;
    uint16_t seen = UINT16_C(0);
    int any_null = 0;

    if (out == NULL) {
        return -1;
    }
    (void)memset(out, 0, sizeof(*out));
    (void)memset(&parsed, 0, sizeof(parsed));
    if (data == NULL || len == 0U || len > GI_PRODUCER_RECEIPT_MAX_LEN) {
        return -1;
    }
    for (index = 0U; index < len; ++index) {
        if (data[index] == '\0') {
            return -1;
        }
    }
    index = 0U;
    gi_skip_json_whitespace(data, len, &index);
    if (index >= len || data[index] != '{') {
        return -1;
    }
    ++index;
    for (;;) {
        unsigned int field;
        uint16_t bit;

        gi_skip_json_whitespace(data, len, &index);
        if (index >= len || data[index] == '}') {
            return -1;
        }
        if (gi_parse_key(data, len, &index, &field) != 0) {
            return -1;
        }
        bit = (uint16_t)(UINT16_C(1) << field);
        if ((seen & bit) != UINT16_C(0)) {
            return -1;
        }
        seen = (uint16_t)(seen | bit);
        gi_skip_json_whitespace(data, len, &index);
        if (index >= len || data[index] != ':') {
            return -1;
        }
        ++index;
        gi_skip_json_whitespace(data, len, &index);
        switch (field) {
        case GI_FIELD_SCHEMA_VERSION: {
            uint64_t schema_version;

            if (gi_parse_uint(data, len, &index, UINT64_MAX,
                              &schema_version) != 0 ||
                schema_version != (uint64_t)GI_PRODUCER_RECEIPT_SCHEMA_VERSION) {
                return -1;
            }
            break;
        }
        case GI_FIELD_PRODUCER_ID:
            if (gi_parse_plain_string(data, len, &index,
                                      parsed.producer_id,
                                      sizeof(parsed.producer_id), 0U, 1) != 0) {
                return -1;
            }
            break;
        case GI_FIELD_INSTANCE_SHA256:
            if (gi_parse_plain_string(data, len, &index,
                                      parsed.instance_sha256,
                                      sizeof(parsed.instance_sha256),
                                      GI_PRODUCER_SHA256_HEX_LEN, 0) != 0) {
                return -1;
            }
            break;
        case GI_FIELD_BUILD_SHA256:
            if (gi_parse_plain_string(data, len, &index,
                                      parsed.build_sha256,
                                      sizeof(parsed.build_sha256),
                                      GI_PRODUCER_SHA256_HEX_LEN, 0) != 0) {
                return -1;
            }
            break;
        case GI_FIELD_CONFIG_SHA256:
            if (gi_parse_plain_string(data, len, &index,
                                      parsed.config_sha256,
                                      sizeof(parsed.config_sha256),
                                      GI_PRODUCER_SHA256_HEX_LEN, 0) != 0) {
                return -1;
            }
            break;
        case GI_FIELD_REQUEST_NONCE_SHA256:
            if (gi_parse_plain_string(data, len, &index,
                                      parsed.request_nonce_sha256,
                                      sizeof(parsed.request_nonce_sha256),
                                      GI_PRODUCER_SHA256_HEX_LEN, 0) != 0) {
                return -1;
            }
            break;
        case GI_FIELD_ACTIVE:
            {
                int is_null;

                if (gi_parse_count(data, len, &index, &parsed.active, &is_null) != 0) {
                    return -1;
                }
                any_null |= is_null;
            }
            break;
        case GI_FIELD_QUEUED:
            {
                int is_null;

                if (gi_parse_count(data, len, &index, &parsed.queued, &is_null) != 0) {
                    return -1;
                }
                any_null |= is_null;
            }
            break;
        case GI_FIELD_LOADING:
            {
                int is_null;

                if (gi_parse_count(data, len, &index, &parsed.loading, &is_null) != 0) {
                    return -1;
                }
                any_null |= is_null;
            }
            break;
        case GI_FIELD_WORK_STARTED:
            {
                int is_null;

                if (gi_parse_count(data, len, &index, &parsed.work_started, &is_null) != 0) {
                    return -1;
                }
                any_null |= is_null;
            }
            break;
        default:
            return -1;
        }
        ++field_count;
        gi_skip_json_whitespace(data, len, &index);
        if (index >= len) {
            return -1;
        }
        if (data[index] == ',') {
            ++index;
            continue;
        }
        if (data[index] == '}') {
            ++index;
            break;
        }
        return -1;
    }
    gi_skip_json_whitespace(data, len, &index);
    if (field_count != GI_FIELD_COUNT || seen != GI_RECEIPT_ALL_FIELDS || index != len) {
        return -1;
    }
    if (any_null) {
        parsed.active = UINT64_C(0);
        parsed.queued = UINT64_C(0);
        parsed.loading = UINT64_C(0);
        parsed.work_started = UINT64_C(0);
        parsed.known = false;
    } else {
        parsed.known = true;
    }
    *out = parsed;
    return 0;
}
