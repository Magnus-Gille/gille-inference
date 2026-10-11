#include "unit_identity.h"

#include <errno.h>
#include <limits.h>
#include <string.h>

static int gi_normalize_result(int result)
{
    return result < 0 ? result : -EPROTO;
}

static size_t gi_bounded_length(const char *value, size_t maximum)
{
    size_t length;

    for (length = 0U; length < maximum; ++length) {
        if (value[length] == '\0') {
            break;
        }
    }
    return length;
}

static int gi_begin_variant(sd_bus_message *reply, const char *signature)
{
    const char *message_signature;
    int result;

    if (reply == NULL || signature == NULL) {
        return -EINVAL;
    }

    result = sd_bus_message_rewind(reply, 1);
    if (result < 0) {
        return result;
    }
    message_signature = sd_bus_message_get_signature(reply, 1);
    if (message_signature == NULL || strcmp(message_signature, "v") != 0) {
        return -EPROTO;
    }
    result = sd_bus_message_enter_container(reply, SD_BUS_TYPE_VARIANT,
                                             signature);
    if (result <= 0) {
        return result < 0 ? result : -EPROTO;
    }
    return 0;
}

static int gi_finish_variant(sd_bus_message *reply)
{
    int result;

    result = sd_bus_message_at_end(reply, 1);
    if (result < 0) {
        return result;
    }
    if (result == 0) {
        return -EPROTO;
    }
    result = sd_bus_message_exit_container(reply);
    if (result < 0) {
        return result;
    }
    result = sd_bus_message_at_end(reply, 1);
    if (result < 0) {
        return result;
    }
    return result == 1 ? 0 : -EPROTO;
}

static int gi_parse_uint(sd_bus_message *reply, const char *signature,
                         uint32_t *value)
{
    uint32_t parsed = 0U;
    int result;

    result = gi_begin_variant(reply, signature);
    if (result < 0) {
        return result;
    }
    result = sd_bus_message_read(reply, "u", &parsed);
    if (result <= 0) {
        return result < 0 ? result : -EPROTO;
    }
    result = gi_finish_variant(reply);
    if (result < 0) {
        return result;
    }
    *value = parsed;
    return 0;
}

int gi_parse_unit_invocation(sd_bus_message *reply,
                             struct gi_unit_invocation *out)
{
    const void *data = NULL;
    struct gi_unit_invocation parsed;
    size_t size = 0U;
    int nonzero = 0;
    int result;
    size_t index;

    if (out != NULL) {
        memset(out, 0, sizeof *out);
    }
    if (reply == NULL || out == NULL) {
        return -EINVAL;
    }
    memset(&parsed, 0, sizeof parsed);
    result = gi_begin_variant(reply, "ay");
    if (result < 0) {
        goto fail;
    }
    result = sd_bus_message_read_array(reply, SD_BUS_TYPE_BYTE, &data, &size);
    if (result <= 0) {
        result = result < 0 ? result : -EPROTO;
        goto fail;
    }
    if (size != sizeof parsed.bytes) {
        result = size > sizeof parsed.bytes ? -E2BIG : -EINVAL;
        goto fail;
    }
    memcpy(parsed.bytes, data, sizeof parsed.bytes);
    for (index = 0U; index < sizeof parsed.bytes; ++index) {
        if (parsed.bytes[index] != 0U) {
            nonzero = 1;
            break;
        }
    }
    if (!nonzero) {
        result = -EINVAL;
        goto fail;
    }
    result = gi_finish_variant(reply);
    if (result < 0) {
        goto fail;
    }
    *out = parsed;
    return 0;

fail:
    memset(out, 0, sizeof *out);
    return gi_normalize_result(result);
}

int gi_parse_service_main_pid(sd_bus_message *reply, uint32_t *out)
{
    uint32_t parsed = 0U;
    int result;

    if (out != NULL) {
        *out = 0U;
    }
    if (reply == NULL || out == NULL) {
        return -EINVAL;
    }
    result = gi_parse_uint(reply, "u", &parsed);
    if (result < 0) {
        return gi_normalize_result(result);
    }
    if (parsed == 0U || (uint64_t)parsed > (uint64_t)INT_MAX) {
        return -EINVAL;
    }
    *out = parsed;
    return 0;
}

int gi_parse_service_restarts(sd_bus_message *reply, uint32_t *out)
{
    uint32_t parsed = 0U;
    int result;

    if (out != NULL) {
        *out = 0U;
    }
    if (reply == NULL || out == NULL) {
        return -EINVAL;
    }
    result = gi_parse_uint(reply, "u", &parsed);
    if (result < 0) {
        return gi_normalize_result(result);
    }
    *out = parsed;
    return 0;
}

static int gi_valid_cgroup_path(const char *path, size_t length)
{
    size_t index = 0U;
    size_t segment_start;

    if (length < 2U || path[0] != '/') {
        return 0;
    }
    while (index < length) {
        if (path[index] != '/') {
            return 0;
        }
        ++index;
        segment_start = index;
        while (index < length && path[index] != '/') {
            unsigned char character = (unsigned char)path[index];
            int valid = (character >= 'A' && character <= 'Z') ||
                        (character >= 'a' && character <= 'z') ||
                        (character >= '0' && character <= '9') ||
                        character == '_' || character == '.' ||
                        character == '@' || character == '-';

            if (!valid) {
                return 0;
            }
            ++index;
        }
        if (index == segment_start ||
            (index - segment_start == 1U && path[segment_start] == '.') ||
            (index - segment_start == 2U && path[segment_start] == '.' &&
             path[segment_start + 1U] == '.')) {
            return 0;
        }
    }
    return 1;
}

int gi_parse_service_cgroup(sd_bus_message *reply,
                            struct gi_service_cgroup *out)
{
    const char *path = NULL;
    struct gi_service_cgroup parsed;
    size_t length;
    int result;

    if (out != NULL) {
        memset(out, 0, sizeof *out);
    }
    if (reply == NULL || out == NULL) {
        return -EINVAL;
    }
    memset(&parsed, 0, sizeof parsed);
    result = gi_begin_variant(reply, "s");
    if (result < 0) {
        goto fail;
    }
    result = sd_bus_message_read(reply, "s", &path);
    if (result <= 0 || path == NULL) {
        result = result < 0 ? result : -EPROTO;
        goto fail;
    }
    length = gi_bounded_length(path, sizeof parsed.path);
    if (length >= sizeof parsed.path || !gi_valid_cgroup_path(path, length)) {
        result = length >= sizeof parsed.path ? -E2BIG : -EINVAL;
        goto fail;
    }
    memcpy(parsed.path, path, length + 1U);
    result = gi_finish_variant(reply);
    if (result < 0) {
        goto fail;
    }
    *out = parsed;
    return 0;

fail:
    memset(out, 0, sizeof *out);
    return gi_normalize_result(result);
}
