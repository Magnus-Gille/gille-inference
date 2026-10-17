#include "counters.h"

#include <inttypes.h>
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

static int test_mem_available(void)
{
    static const char realistic[] =
        "MemTotal:       16384256 kB\n"
        "MemFree:         123456 kB\n"
        "MemAvailable:\t 987654 \t kB \n"
        "Buffers:           100 kB\n";
    static const char max_value[] =
        "MemAvailable: 18014398509481983 kB\n";
    static const char overflow_value[] =
        "MemAvailable: 18014398509481984 kB\n";
    static const char no_newline[] = "MemAvailable: 7 kB";
    static const char duplicate[] =
        "MemAvailable: 1 kB\nMemAvailable: 2 kB\n";
    static const char missing[] = "MemFree: 7 kB\n";
    static const char prefix[] = "MemAvailableExtra: 7 kB\n";
    static const char bad_unit[] = "MemAvailable: 7 KB\n";
    static const char negative[] = "MemAvailable: -1 kB\n";
    static const char junk[] = "MemAvailable: 7 kB trailing\n";
    static const char nul_value[] = "MemAvailable: 7 kB\0\n";
    static const char max_len_prefix[] = "MemAvailable: 1 kB\n";
    char max_len[65536];
    char oversized[65537];
    uint64_t value = UINT64_C(0xfeedface);

    CHECK(gi_parse_mem_available(realistic, sizeof(realistic) - 1U, &value) == 0);
    CHECK(value == UINT64_C(987654) * UINT64_C(1024));
    CHECK(gi_parse_mem_available(max_value, sizeof(max_value) - 1U, &value) == 0);
    CHECK(value == UINT64_MAX - UINT64_C(1023));

    value = UINT64_C(0xfeedface);
    CHECK(gi_parse_mem_available(overflow_value, sizeof(overflow_value) - 1U,
                                 &value) == -1);
    CHECK(value == UINT64_C(0xfeedface));
    CHECK(gi_parse_mem_available(no_newline, sizeof(no_newline) - 1U, &value) == 0);
    CHECK(value == UINT64_C(7) * UINT64_C(1024));

    value = UINT64_C(0xfeedface);
    CHECK(gi_parse_mem_available(duplicate, sizeof(duplicate) - 1U, &value) == -1);
    CHECK(value == UINT64_C(0xfeedface));
    CHECK(gi_parse_mem_available(missing, sizeof(missing) - 1U, &value) == -1);
    CHECK(gi_parse_mem_available(prefix, sizeof(prefix) - 1U, &value) == -1);
    CHECK(gi_parse_mem_available(bad_unit, sizeof(bad_unit) - 1U, &value) == -1);
    CHECK(gi_parse_mem_available(negative, sizeof(negative) - 1U, &value) == -1);
    CHECK(gi_parse_mem_available(junk, sizeof(junk) - 1U, &value) == -1);
    CHECK(gi_parse_mem_available(nul_value, sizeof(nul_value) - 1U, &value) == -1);
    CHECK(gi_parse_mem_available(NULL, 0U, &value) == -1);
    CHECK(gi_parse_mem_available(realistic, sizeof(realistic) - 1U, NULL) == -1);

    (void)memset(max_len, 'x', sizeof(max_len));
    (void)memcpy(max_len, max_len_prefix, sizeof(max_len_prefix) - 1U);
    CHECK(gi_parse_mem_available(max_len, sizeof(max_len), &value) == 0);
    CHECK(value == UINT64_C(1024));
    (void)memset(oversized, 'x', sizeof(oversized));
    CHECK(gi_parse_mem_available(oversized, sizeof(oversized), &value) == -1);
    return 0;
}

static int test_oom_kill(void)
{
    static const char realistic[] =
        "nr_free_pages 1234\n"
        "oom_kill\t 42 \n"
        "pgfault 999\n";
    static const char realistic_memory_events[] =
        "low 0\n"
        "high 1\n"
        "max 2\n"
        "oom 3\n"
        "oom_kill 4\n"
        "oom_group_kill 5\n";
    static const char max_value[] = "oom_kill 18446744073709551615";
    static const char overflow_value[] = "oom_kill 18446744073709551616";
    static const char duplicate[] = "oom_kill 1\noom_kill 2\n";
    static const char missing[] = "oom_score 1\n";
    static const char prefix[] = "oom_killer 1\n";
    static const char bare[] = "oom_kill\n";
    static const char valid_with_prefix_lookalike[] =
        "oom_kill 9\noom_killer 10\n";
    static const char negative[] = "oom_kill -1\n";
    static const char junk[] = "oom_kill 1x\n";
    static const char nul_value[] = "oom_kill 1\0\n";
    static const char max_len_prefix[] = "oom_kill 1\n";
    char max_len[65536];
    char oversized[65537];
    uint64_t value = UINT64_C(0xfeedface);

    CHECK(gi_parse_oom_kill(realistic, sizeof(realistic) - 1U, &value) == 0);
    CHECK(value == UINT64_C(42));
    CHECK(gi_parse_oom_kill(realistic_memory_events,
                            sizeof(realistic_memory_events) - 1U,
                            &value) == 0);
    CHECK(value == UINT64_C(4));
    CHECK(gi_parse_oom_kill(max_value, sizeof(max_value) - 1U, &value) == 0);
    CHECK(value == UINT64_MAX);

    value = UINT64_C(0xfeedface);
    CHECK(gi_parse_oom_kill(overflow_value, sizeof(overflow_value) - 1U,
                            &value) == -1);
    CHECK(value == UINT64_C(0xfeedface));
    CHECK(gi_parse_oom_kill(duplicate, sizeof(duplicate) - 1U, &value) == -1);
    CHECK(value == UINT64_C(0xfeedface));
    CHECK(gi_parse_oom_kill(missing, sizeof(missing) - 1U, &value) == -1);
    CHECK(gi_parse_oom_kill(prefix, sizeof(prefix) - 1U, &value) == -1);
    CHECK(gi_parse_oom_kill(bare, sizeof(bare) - 1U, &value) == -1);
    CHECK(gi_parse_oom_kill(valid_with_prefix_lookalike,
                            sizeof(valid_with_prefix_lookalike) - 1U,
                            &value) == 0);
    CHECK(value == UINT64_C(9));
    CHECK(gi_parse_oom_kill(negative, sizeof(negative) - 1U, &value) == -1);
    CHECK(gi_parse_oom_kill(junk, sizeof(junk) - 1U, &value) == -1);
    CHECK(gi_parse_oom_kill(nul_value, sizeof(nul_value) - 1U, &value) == -1);
    CHECK(gi_parse_oom_kill(NULL, 0U, &value) == -1);
    CHECK(gi_parse_oom_kill(realistic, sizeof(realistic) - 1U, NULL) == -1);

    (void)memset(max_len, 'x', sizeof(max_len));
    (void)memcpy(max_len, max_len_prefix, sizeof(max_len_prefix) - 1U);
    CHECK(gi_parse_oom_kill(max_len, sizeof(max_len), &value) == 0);
    CHECK(value == UINT64_C(1));
    (void)memset(oversized, 'x', sizeof(oversized));
    CHECK(gi_parse_oom_kill(oversized, sizeof(oversized), &value) == -1);
    return 0;
}

int main(void)
{
    CHECK(test_mem_available() == 0);
    CHECK(test_oom_kill() == 0);
    puts("all counter parser tests passed");
    return 0;
}
