#include "proc_stat.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void expect_ok(const char *data, struct gi_proc_stat expected)
{
    struct gi_proc_stat actual = { 0U, 0U, 0U };
    size_t len = strlen(data);

    assert(gi_parse_proc_stat(data, len, &actual) == 0);
    assert(actual.pid == expected.pid);
    assert(actual.flags == expected.flags);
    assert(actual.start_ticks == expected.start_ticks);
}

static void expect_invalid(const char *data, size_t len)
{
    struct gi_proc_stat actual = { 11U, 22U, 33U };
    const struct gi_proc_stat before = actual;

    assert(gi_parse_proc_stat(data, len, &actual) == -1);
    assert(memcmp(&actual, &before, sizeof actual) == 0);
}

static void test_real_style_52_and_minimum(void)
{
    static const char *const full =
        "123 (worker thread) S 1 2 3 4 5 2748 7 8 9 10 11 12 -13 -14 -15 16 17 18 "
        "1048576 99 100 101 102 103 104 105 106 107 108 109 "
        "110 111 112 113 114 115 116 117 118 119 120 121 122 123 124 125 126 127 128";
    static const char *const minimum =
        "7 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 42";

    expect_ok(full, (struct gi_proc_stat){ 123U, 2748U, UINT64_C(1048576) });
    expect_ok(minimum, (struct gi_proc_stat){ 7U, 6U, 42U });
}

static void test_tricky_comm_and_optional_newline(void)
{
    static const char data[] =
        "42 (name ) S with newline\n and ) R inside) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19\n";

    expect_ok(data, (struct gi_proc_stat){ 42U, 6U, 19U });
}

static void test_shape_and_ranges(void)
{
    static const char *const missing = "7 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18";
    static const char *const extra =
        "7 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 "
        "26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50";
    static const char *const bad_state = "7 (tiny) Q 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19";
    static const char *const trailing = "7 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19junk";
    char oversized[8193];

    expect_invalid(missing, strlen(missing));
    expect_invalid(extra, strlen(extra));
    expect_invalid(bad_state, strlen(bad_state));
    expect_invalid(trailing, strlen(trailing));
    memset(oversized, '1', sizeof oversized);
    expect_invalid(oversized, sizeof oversized);
}

static void test_numeric_rejection(void)
{
    static const char *const zero_pid = "0 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19";
    static const char *const huge_pid = "2147483648 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19";
    static const char *const huge_flags = "7 (tiny) R 1 2 3 4 5 18446744073709551616 7 8 9 10 11 12 13 14 15 16 17 18 19";
    static const char *const negative_start = "7 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 -17";
    static const char *const signed_min = "7 (tiny) R -1 -2 -3 -4 -5 6 7 8 9 10 11 12 -13 -14 -15 16 17 18 19";

    expect_invalid(zero_pid, strlen(zero_pid));
    expect_invalid(huge_pid, strlen(huge_pid));
    expect_invalid(huge_flags, strlen(huge_flags));
    expect_invalid(negative_start, strlen(negative_start));
    expect_ok(signed_min, (struct gi_proc_stat){ 7U, 6U, 19U });
}

static void test_embedded_nul_and_null_args(void)
{
    static const char prefix[] = "7 (tiny) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19";
    char embedded[sizeof prefix + 1U];

    memcpy(embedded, prefix, sizeof prefix);
    embedded[sizeof prefix - 2U] = '\0';
    expect_invalid(embedded, sizeof embedded);
    assert(gi_parse_proc_stat(NULL, 0U, &(struct gi_proc_stat){ 0U, 0U, 0U }) == -1);
    assert(gi_parse_proc_stat(prefix, strlen(prefix), NULL) == -1);
}

int main(void)
{
    test_real_style_52_and_minimum();
    test_tricky_comm_and_optional_newline();
    test_shape_and_ranges();
    test_numeric_rejection();
    test_embedded_nul_and_null_args();
    (void)puts("proc_stat tests: ok");
    return 0;
}
