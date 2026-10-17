#include "cgroup_limits.h"

#include <stdint.h>
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

static int bytes_are_zero(const void *object, size_t length)
{
    const unsigned char *bytes = (const unsigned char *)object;
    size_t index;

    for (index = 0U; index < length; ++index) {
        if (bytes[index] != 0U) {
            return 0;
        }
    }
    return 1;
}

static int expect_limit_failure(const char *data, size_t length)
{
    uint64_t output = UINT64_C(0xa5a5a5a5a5a5a5a5);

    CHECK(gi_parse_cgroup_limit(data, length, &output) == -1);
    CHECK(output == 0U);
    return 0;
}

static int expect_cpu_failure(const char *data, size_t length)
{
    struct gi_cpu_max output;

    (void)memset(&output, 0xa5, sizeof(output));
    CHECK(gi_parse_cpu_max(data, length, &output) == -1);
    CHECK(bytes_are_zero(&output, sizeof(output)));
    return 0;
}

static int test_cgroup_limits(void)
{
    static const char zero[] = "0\n";
    static const char one[] = "1\n";
    static const char maximum[] = "18446744073709551615\n";
    static const char leading_zero[] = "01\n";
    static const char overflow[] = "18446744073709551616\n";
    static const char extra_newline[] = "1\n\n";
    static const char embedded_nul[] = "1\0\n";
    static const char too_long[] = "12345678901234567890\n0";
    uint64_t output = 0U;

    CHECK(gi_parse_cgroup_limit(zero, sizeof(zero) - 1U, &output) == 0);
    CHECK(output == 0U);
    CHECK(gi_parse_cgroup_limit(one, sizeof(one) - 1U, &output) == 0);
    CHECK(output == 1U);
    CHECK(gi_parse_cgroup_limit(maximum, sizeof(maximum) - 1U, &output) == 0);
    CHECK(output == UINT64_MAX);

    CHECK(expect_limit_failure(NULL, 0U) == 0);
    CHECK(expect_limit_failure(NULL, 2U) == 0);
    CHECK(expect_limit_failure(one, 0U) == 0);
    CHECK(expect_limit_failure("123", sizeof("123") - 1U) == 0);
    CHECK(expect_limit_failure("\n", 1U) == 0);
    CHECK(expect_limit_failure(leading_zero, sizeof(leading_zero) - 1U) == 0);
    CHECK(expect_limit_failure("+1\n", sizeof("+1\n") - 1U) == 0);
    CHECK(expect_limit_failure("-1\n", sizeof("-1\n") - 1U) == 0);
    CHECK(expect_limit_failure(" 1\n", sizeof(" 1\n") - 1U) == 0);
    CHECK(expect_limit_failure("1 \n", sizeof("1 \n") - 1U) == 0);
    CHECK(expect_limit_failure("max\n", sizeof("max\n") - 1U) == 0);
    CHECK(expect_limit_failure("1\r\n", sizeof("1\r\n") - 1U) == 0);
    CHECK(expect_limit_failure(embedded_nul, sizeof(embedded_nul) - 1U) == 0);
    CHECK(expect_limit_failure(overflow, sizeof(overflow) - 1U) == 0);
    CHECK(expect_limit_failure(extra_newline, sizeof(extra_newline) - 1U) == 0);
    CHECK(expect_limit_failure(too_long, sizeof(too_long) - 1U) == 0);
    CHECK(expect_limit_failure((const char *)(uintptr_t)1, SIZE_MAX) == 0);
    CHECK(gi_parse_cgroup_limit(one, sizeof(one) - 1U, NULL) == -1);
    return 0;
}

static int test_cpu_max(void)
{
    static const char lower[] = "1 1000\n";
    static const char maximum_quota[] = "18446744073709551615 1000\n";
    static const char upper[] = "18446744073709551614 1000000\n";
    static const char embedded_nul[] = "1 1000\0\n";
    static const char too_long[] =
        "1234567890123456789012345678901234567890120\n";
    struct gi_cpu_max output;

    CHECK(gi_parse_cpu_max(lower, sizeof(lower) - 1U, &output) == 0);
    CHECK(output.quota_us == 1U && output.period_us == 1000U);
    CHECK(gi_parse_cpu_max(maximum_quota, sizeof(maximum_quota) - 1U,
                           &output) == 0);
    CHECK(output.quota_us == UINT64_MAX && output.period_us == 1000U);
    CHECK(gi_parse_cpu_max(upper, sizeof(upper) - 1U, &output) == 0);
    CHECK(output.quota_us == UINT64_MAX - 1U && output.period_us == 1000000U);

    CHECK(expect_cpu_failure(NULL, 0U) == 0);
    CHECK(expect_cpu_failure(NULL, 7U) == 0);
    CHECK(expect_cpu_failure(lower, 0U) == 0);
    CHECK(expect_cpu_failure("\n", 1U) == 0);
    CHECK(expect_cpu_failure("1 999\n", sizeof("1 999\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 1000001\n", sizeof("1 1000001\n") - 1U) == 0);
    CHECK(expect_cpu_failure("0 1000\n", sizeof("0 1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 0\n", sizeof("1 0\n") - 1U) == 0);
    CHECK(expect_cpu_failure("01 1000\n", sizeof("01 1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 01000\n", sizeof("1 01000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("max 1000\n", sizeof("max 1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 max\n", sizeof("1 max\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 18446744073709551615\n",
                             sizeof("1 18446744073709551615\n") - 1U) == 0);
    CHECK(expect_cpu_failure("+1 1000\n", sizeof("+1 1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 -1000\n", sizeof("1 -1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1  1000\n", sizeof("1  1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1\t1000\n", sizeof("1\t1000\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 1000 1\n", sizeof("1 1000 1\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 1000", sizeof("1 1000") - 1U) == 0);
    CHECK(expect_cpu_failure("1 1000\n\n", sizeof("1 1000\n\n") - 1U) == 0);
    CHECK(expect_cpu_failure("1 1000\r\n", sizeof("1 1000\r\n") - 1U) == 0);
    CHECK(expect_cpu_failure(embedded_nul, sizeof(embedded_nul) - 1U) == 0);
    CHECK(expect_cpu_failure(too_long, sizeof(too_long) - 1U) == 0);
    CHECK(expect_cpu_failure((const char *)(uintptr_t)1, SIZE_MAX) == 0);
    CHECK(gi_parse_cpu_max(lower, sizeof(lower) - 1U, NULL) == -1);
    return 0;
}

int main(void)
{
    CHECK(test_cgroup_limits() == 0);
    CHECK(test_cpu_max() == 0);
    puts("all cgroup limits parser tests passed");
    return 0;
}
