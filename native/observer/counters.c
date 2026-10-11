#include "counters.h"

#include <string.h>

#define GI_COUNTERS_MAX_LEN ((size_t)65536U)

static int gi_is_space_tab(char value)
{
    return value == ' ' || value == '\t';
}

static int gi_parse_u64(const char *data, size_t start, size_t end,
                        size_t *next, uint64_t *value)
{
    size_t index = start;
    uint64_t parsed = UINT64_C(0);

    if (index == end || data[index] < '0' || data[index] > '9') {
        return -1;
    }
    while (index < end && data[index] >= '0' && data[index] <= '9') {
        uint64_t digit = (uint64_t)(data[index] - '0');

        if (parsed > (UINT64_MAX - digit) / UINT64_C(10)) {
            return -1;
        }
        parsed = parsed * UINT64_C(10) + digit;
        ++index;
    }
    *next = index;
    *value = parsed;
    return 0;
}

static int gi_line_has_prefix(const char *data, size_t start, size_t end,
                              const char *prefix, size_t prefix_len)
{
    return end - start >= prefix_len &&
           memcmp(data + start, prefix, prefix_len) == 0;
}

static int gi_line_has_key_with_space(const char *data, size_t start, size_t end,
                                      const char *key, size_t key_len)
{
    if (!gi_line_has_prefix(data, start, end, key, key_len)) {
        return 0;
    }
    return end - start == key_len || gi_is_space_tab(data[start + key_len]);
}

static int gi_parse_mem_line(const char *data, size_t start, size_t end,
                             uint64_t *value)
{
    static const char key[] = "MemAvailable:";
    size_t index = start + sizeof(key) - 1U;
    size_t number_end;
    uint64_t kilobytes;

    while (index < end && gi_is_space_tab(data[index])) {
        ++index;
    }
    if (gi_parse_u64(data, index, end, &number_end, &kilobytes) != 0) {
        return -1;
    }
    index = number_end;
    if (index == end || !gi_is_space_tab(data[index])) {
        return -1;
    }
    while (index < end && gi_is_space_tab(data[index])) {
        ++index;
    }
    if (end - index < 2U || data[index] != 'k' || data[index + 1U] != 'B') {
        return -1;
    }
    index += 2U;
    while (index < end && gi_is_space_tab(data[index])) {
        ++index;
    }
    if (index != end || kilobytes > UINT64_MAX / UINT64_C(1024)) {
        return -1;
    }
    *value = kilobytes * UINT64_C(1024);
    return 0;
}

static int gi_parse_oom_line(const char *data, size_t start, size_t end,
                             uint64_t *value)
{
    static const char key[] = "oom_kill";
    size_t index = start + sizeof(key) - 1U;
    size_t number_end;
    uint64_t parsed;

    if (index == end || !gi_is_space_tab(data[index])) {
        return -1;
    }
    while (index < end && gi_is_space_tab(data[index])) {
        ++index;
    }
    if (gi_parse_u64(data, index, end, &number_end, &parsed) != 0) {
        return -1;
    }
    index = number_end;
    while (index < end && gi_is_space_tab(data[index])) {
        ++index;
    }
    if (index != end) {
        return -1;
    }
    *value = parsed;
    return 0;
}

static int gi_input_is_valid(const char *data, size_t len)
{
    size_t index;

    if (data == NULL || len == 0U || len > GI_COUNTERS_MAX_LEN) {
        return 0;
    }
    for (index = 0U; index < len; ++index) {
        if (data[index] == '\0') {
            return 0;
        }
    }
    return 1;
}

int gi_parse_mem_available(const char *data, size_t len, uint64_t *outBytes)
{
    static const char key[] = "MemAvailable:";
    size_t line_start;
    uint64_t parsed_value = UINT64_C(0);
    unsigned int matches = 0U;

    if (outBytes == NULL || !gi_input_is_valid(data, len)) {
        return -1;
    }
    line_start = 0U;
    while (line_start < len) {
        size_t line_end = line_start;

        while (line_end < len && data[line_end] != '\n') {
            ++line_end;
        }
        if (gi_line_has_prefix(data, line_start, line_end, key,
                                sizeof(key) - 1U)) {
            uint64_t line_value;

            if (gi_parse_mem_line(data, line_start, line_end, &line_value) != 0) {
                return -1;
            }
            ++matches;
            parsed_value = line_value;
        }
        if (line_end == len) {
            break;
        }
        line_start = line_end + 1U;
    }
    if (matches != 1U) {
        return -1;
    }
    *outBytes = parsed_value;
    return 0;
}

int gi_parse_oom_kill(const char *data, size_t len, uint64_t *out)
{
    static const char key[] = "oom_kill";
    size_t line_start;
    uint64_t parsed_value = UINT64_C(0);
    unsigned int matches = 0U;

    if (out == NULL || !gi_input_is_valid(data, len)) {
        return -1;
    }
    line_start = 0U;
    while (line_start < len) {
        size_t line_end = line_start;

        while (line_end < len && data[line_end] != '\n') {
            ++line_end;
        }
        if (gi_line_has_key_with_space(data, line_start, line_end, key,
                                       sizeof(key) - 1U)) {
            uint64_t line_value;

            if (gi_parse_oom_line(data, line_start, line_end, &line_value) != 0) {
                return -1;
            }
            ++matches;
            parsed_value = line_value;
        }
        if (line_end == len) {
            break;
        }
        line_start = line_end + 1U;
    }
    if (matches != 1U) {
        return -1;
    }
    *out = parsed_value;
    return 0;
}
