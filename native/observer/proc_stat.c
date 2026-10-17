#include "proc_stat.h"

#include <limits.h>

#define GI_PROC_STAT_MAX_LEN ((size_t)8192U)

enum gi_proc_field_kind {
    GI_PROC_FIELD_SIGNED,
    GI_PROC_FIELD_UNSIGNED
};

static int gi_is_state_char(char value)
{
    switch (value) {
    case 'R':
    case 'S':
    case 'D':
    case 'Z':
    case 'T':
    case 't':
    case 'W':
    case 'X':
    case 'x':
    case 'K':
    case 'P':
    case 'I':
        return 1;
    default:
        return 0;
    }
}

static enum gi_proc_field_kind gi_field_kind(unsigned int field)
{
    switch (field) {
    case 9U:
    case 10U:
    case 11U:
    case 12U:
    case 13U:
    case 14U:
    case 15U:
    case 22U:
    case 23U:
    case 25U:
    case 26U:
    case 27U:
    case 28U:
    case 29U:
    case 30U:
    case 31U:
    case 32U:
    case 33U:
    case 34U:
    case 35U:
    case 36U:
    case 37U:
    case 40U:
    case 41U:
    case 42U:
    case 43U:
    case 44U:
    case 45U:
    case 46U:
    case 47U:
    case 48U:
    case 49U:
    case 50U:
    case 51U:
        return GI_PROC_FIELD_UNSIGNED;
    default:
        return GI_PROC_FIELD_SIGNED;
    }
}

static int gi_parse_unsigned(const char *data, size_t start, size_t end,
                             uint64_t *value)
{
    size_t index;
    uint64_t parsed = UINT64_C(0);

    if (start == end) {
        return -1;
    }
    for (index = start; index < end; ++index) {
        unsigned int digit;

        if (data[index] < '0' || data[index] > '9') {
            return -1;
        }
        digit = (unsigned int)(data[index] - '0');
        if (parsed > (UINT64_MAX - (uint64_t)digit) / UINT64_C(10)) {
            return -1;
        }
        parsed = parsed * UINT64_C(10) + (uint64_t)digit;
    }
    *value = parsed;
    return 0;
}

static int gi_parse_signed(const char *data, size_t start, size_t end,
                           int64_t *value)
{
    size_t index = start;
    int negative = 0;
    uint64_t limit;
    uint64_t magnitude = UINT64_C(0);

    if (start == end) {
        return -1;
    }
    if (data[index] == '-') {
        negative = 1;
        ++index;
        if (index == end) {
            return -1;
        }
    }
    limit = negative ? (UINT64_C(1) << 63) : (UINT64_C(1) << 63) - UINT64_C(1);
    for (; index < end; ++index) {
        unsigned int digit;

        if (data[index] < '0' || data[index] > '9') {
            return -1;
        }
        digit = (unsigned int)(data[index] - '0');
        if (magnitude > (limit - (uint64_t)digit) / UINT64_C(10)) {
            return -1;
        }
        magnitude = magnitude * UINT64_C(10) + (uint64_t)digit;
    }
    if (negative) {
        if (magnitude == (UINT64_C(1) << 63)) {
            *value = INT64_MIN;
        } else {
            *value = -(int64_t)magnitude;
        }
    } else {
        *value = (int64_t)magnitude;
    }
    return 0;
}

int gi_parse_proc_stat(const char *data, size_t len, struct gi_proc_stat *out)
{
    size_t effective_len;
    size_t index;
    size_t pid_end;
    size_t open_paren;
    size_t close_paren = 0U;
    size_t numeric_start;
    unsigned int field;
    uint64_t parsed_pid;
    uint64_t parsed_flags = UINT64_C(0);
    uint64_t parsed_start = UINT64_C(0);
    int64_t signed_value;

    if (data == NULL || out == NULL || len == 0U || len > GI_PROC_STAT_MAX_LEN) {
        return -1;
    }
    for (index = 0U; index < len; ++index) {
        if (data[index] == '\0') {
            return -1;
        }
    }

    effective_len = len;
    if (data[effective_len - 1U] == '\n') {
        --effective_len;
    }
    if (effective_len == 0U) {
        return -1;
    }

    pid_end = 0U;
    while (pid_end < effective_len && data[pid_end] != ' ') {
        ++pid_end;
    }
    if (pid_end == 0U || pid_end == effective_len ||
        gi_parse_unsigned(data, 0U, pid_end, &parsed_pid) != 0 ||
        parsed_pid == UINT64_C(0) || parsed_pid > (uint64_t)INT32_MAX) {
        return -1;
    }
    open_paren = pid_end + 1U;
    if (open_paren >= effective_len || data[open_paren] != '(') {
        return -1;
    }

    for (index = open_paren + 1U; index + 3U < effective_len; ++index) {
        if (data[index] == ')' && data[index + 1U] == ' ' &&
            gi_is_state_char(data[index + 2U]) && data[index + 3U] == ' ') {
            close_paren = index;
        }
    }
    if (close_paren == 0U) {
        return -1;
    }

    numeric_start = close_paren + 4U;
    if (numeric_start >= effective_len) {
        return -1;
    }
    field = 4U;
    index = numeric_start;
    for (;;) {
        size_t token_end = index;

        while (token_end < effective_len && data[token_end] != ' ') {
            ++token_end;
        }
        if (gi_field_kind(field) == GI_PROC_FIELD_UNSIGNED) {
            uint64_t unsigned_value;

            if (gi_parse_unsigned(data, index, token_end, &unsigned_value) != 0) {
                return -1;
            }
            if (field == 9U) {
                parsed_flags = unsigned_value;
            } else if (field == 22U) {
                parsed_start = unsigned_value;
            }
        } else if (gi_parse_signed(data, index, token_end, &signed_value) != 0) {
            return -1;
        }

        if (token_end == effective_len) {
            break;
        }
        if (field == 52U || token_end + 1U >= effective_len ||
            data[token_end + 1U] == ' ') {
            return -1;
        }
        index = token_end + 1U;
        ++field;
    }
    if (field < 22U) {
        return -1;
    }

    out->pid = (uint32_t)parsed_pid;
    out->flags = parsed_flags;
    out->start_ticks = parsed_start;
    return 0;
}
