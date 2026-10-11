#include "cgroup_events.h"

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

static int output_is_zero(const struct gi_cgroup_events *output)
{
    const unsigned char *bytes = (const unsigned char *)output;
    size_t index;

    for (index = 0U; index < sizeof(*output); ++index) {
        if (bytes[index] != 0U) {
            return 0;
        }
    }
    return 1;
}

static int expect_failure(const char *data, size_t len)
{
    struct gi_cgroup_events output;

    (void)memset(&output, 0xa5, sizeof(output));
    CHECK(gi_parse_cgroup_events(data, len, &output) == -1);
    CHECK(output_is_zero(&output));
    return 0;
}

static int test_valid_inputs(void)
{
    static const char populated_first[] = "populated 1\nfrozen 0\n";
    static const char frozen_first[] = "frozen 1\npopulated 0\n";
    struct gi_cgroup_events output;

    CHECK(gi_parse_cgroup_events(populated_first,
                                 sizeof(populated_first) - 1U, &output) == 0);
    CHECK(output.known && output.populated && !output.frozen);
    CHECK(gi_parse_cgroup_events(frozen_first,
                                 sizeof(frozen_first) - 1U, &output) == 0);
    CHECK(output.known && !output.populated && output.frozen);
    return 0;
}

static int test_invalid_inputs(void)
{
    static const char valid[] = "populated 1\nfrozen 0\n";
    static const char missing_populated[] = "frozen 0\n";
    static const char missing_frozen[] = "populated 1\n";
    static const char duplicate[] = "populated 1\nfrozen 0\npopulated 0\n";
    static const char unknown[] = "populated 1\nfrozen 0\nnewfield 1\n";
    static const char exact_key_false_positive[] =
        "populated 1\npopulated_extra 0\nfrozen 0\n";
    static const char truncated_key[] = "populate 1\nfrozen 0\n";
    static const char truncated_value[] = "populated \nfrozen 0\n";
    static const char no_final_newline[] = "populated 1\nfrozen 0";
    static const char blank_line[] = "populated 1\n\nfrozen 0\n";
    static const char tab_separator[] = "populated\t1\nfrozen 0\n";
    static const char two_spaces[] = "populated  1\nfrozen 0\n";
    static const char signed_value[] = "populated +1\nfrozen 0\n";
    static const char extra_token[] = "populated 1 extra\nfrozen 0\n";
    static const char carriage_return[] = "populated 1\r\nfrozen 0\n";
    static const char embedded_nul[] = "populated 1\0\nfrozen 0\n";
    size_t index;

    for (index = 0U; index < sizeof(valid) - 1U; ++index) {
        CHECK(expect_failure(valid, index) == 0);
    }

    CHECK(expect_failure(missing_populated, sizeof(missing_populated) - 1U) == 0);
    CHECK(expect_failure(missing_frozen, sizeof(missing_frozen) - 1U) == 0);
    CHECK(expect_failure(duplicate, sizeof(duplicate) - 1U) == 0);
    CHECK(expect_failure(unknown, sizeof(unknown) - 1U) == 0);
    CHECK(expect_failure(exact_key_false_positive,
                         sizeof(exact_key_false_positive) - 1U) == 0);
    CHECK(expect_failure(truncated_key, sizeof(truncated_key) - 1U) == 0);
    CHECK(expect_failure(truncated_value, sizeof(truncated_value) - 1U) == 0);
    CHECK(expect_failure(no_final_newline, sizeof(no_final_newline) - 1U) == 0);
    CHECK(expect_failure(blank_line, sizeof(blank_line) - 1U) == 0);
    CHECK(expect_failure(tab_separator, sizeof(tab_separator) - 1U) == 0);
    CHECK(expect_failure(two_spaces, sizeof(two_spaces) - 1U) == 0);
    CHECK(expect_failure(signed_value, sizeof(signed_value) - 1U) == 0);
    CHECK(expect_failure(extra_token, sizeof(extra_token) - 1U) == 0);
    CHECK(expect_failure(carriage_return, sizeof(carriage_return) - 1U) == 0);
    CHECK(expect_failure(embedded_nul, sizeof(embedded_nul) - 1U) == 0);
    CHECK(expect_failure(NULL, 0U) == 0);
    CHECK(gi_parse_cgroup_events("populated 1\nfrozen 0\n",
                                 sizeof("populated 1\nfrozen 0\n") - 1U,
                                 NULL) == -1);
    return 0;
}

static int test_length_bounds(void)
{
    char oversized[257];
    char at_limit[256];
    size_t index;

    (void)memset(oversized, 'x', sizeof(oversized));
    CHECK(expect_failure(oversized, sizeof(oversized)) == 0);

    (void)memset(at_limit, 'x', sizeof(at_limit));
    for (index = 0U; index < sizeof(at_limit); ++index) {
        if (at_limit[index] == '\0') {
            return 1;
        }
    }
    CHECK(expect_failure(at_limit, sizeof(at_limit)) == 0);
    return 0;
}

int main(void)
{
    CHECK(test_valid_inputs() == 0);
    CHECK(test_invalid_inputs() == 0);
    CHECK(test_length_bounds() == 0);
    puts("all cgroup events parser tests passed");
    return 0;
}
