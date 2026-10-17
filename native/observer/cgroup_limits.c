#include "cgroup_limits.h"

#include <string.h>

#define GI_CGROUP_LIMIT_MAX_LENGTH ((size_t)21U)
#define GI_CPU_MAX_MAX_LENGTH ((size_t)42U)
#define GI_CPU_MAX_MIN_PERIOD ((uint64_t)1000U)
#define GI_CPU_MAX_MAX_PERIOD ((uint64_t)1000000U)

static int gi_parse_decimal(const char *data, size_t length,
                            int allow_zero, uint64_t *out)
{
    size_t index;
    uint64_t value = 0U;

    if (length == 0U || (length > 1U && data[0] == '0')) {
        return -1;
    }
    for (index = 0U; index < length; ++index) {
        unsigned int digit;

        if (data[index] < '0' || data[index] > '9') {
            return -1;
        }
        digit = (unsigned int)(data[index] - '0');
        if (value > UINT64_MAX / 10U ||
            (value == UINT64_MAX / 10U &&
             (uint64_t)digit > UINT64_MAX % 10U)) {
            return -1;
        }
        value = value * 10U + (uint64_t)digit;
    }
    if (!allow_zero && value == 0U) {
        return -1;
    }
    *out = value;
    return 0;
}

int gi_parse_cgroup_limit(const char *data, size_t length, uint64_t *out)
{
    uint64_t value;

    if (out != NULL) {
        (void)memset(out, 0, sizeof(*out));
    }
    if (out == NULL || data == NULL || length < 2U ||
        length > GI_CGROUP_LIMIT_MAX_LENGTH || data[length - 1U] != '\n' ||
        gi_parse_decimal(data, length - 1U, 1, &value) != 0) {
        return -1;
    }
    *out = value;
    return 0;
}

int gi_parse_cpu_max(const char *data, size_t length, struct gi_cpu_max *out)
{
    size_t separator = 0U;
    size_t index;
    uint64_t quota;
    uint64_t period;

    if (out != NULL) {
        (void)memset(out, 0, sizeof(*out));
    }
    if (out == NULL || data == NULL || length < 5U ||
        length > GI_CPU_MAX_MAX_LENGTH || data[length - 1U] != '\n') {
        return -1;
    }

    while (separator < length - 1U && data[separator] != ' ') {
        ++separator;
    }
    if (separator == 0U || separator >= length - 2U) {
        return -1;
    }
    for (index = separator + 1U; index < length - 1U; ++index) {
        if (data[index] == ' ' || data[index] < '0' || data[index] > '9') {
            return -1;
        }
    }
    if (gi_parse_decimal(data, separator, 0, &quota) != 0 ||
        gi_parse_decimal(data + separator + 1U,
                         length - separator - 2U, 0, &period) != 0 ||
        period < GI_CPU_MAX_MIN_PERIOD || period > GI_CPU_MAX_MAX_PERIOD) {
        return -1;
    }
    out->quota_us = quota;
    out->period_us = period;
    return 0;
}
