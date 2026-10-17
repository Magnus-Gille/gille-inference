#include "cgroup_events.h"

#include <string.h>

#define GI_CGROUP_EVENTS_MAX_LEN ((size_t)256U)

int gi_parse_cgroup_events(const char *data, size_t len,
                           struct gi_cgroup_events *out)
{
    size_t index = 0U;
    unsigned int seen_populated = 0U;
    unsigned int seen_frozen = 0U;
    bool parsed_populated = false;
    bool parsed_frozen = false;

    if (out != NULL) {
        (void)memset(out, 0, sizeof(*out));
    }
    if (out == NULL || data == NULL || len == 0U ||
        len > GI_CGROUP_EVENTS_MAX_LEN) {
        return -1;
    }

    while (index < len) {
        size_t line_start = index;
        size_t line_end = line_start;
        size_t key_len;
        bool *value;
        unsigned int *seen;

        while (line_end < len && data[line_end] != '\n') {
            if (data[line_end] == '\0' || data[line_end] == '\r') {
                return -1;
            }
            ++line_end;
        }
        if (line_end == len || line_end == line_start) {
            return -1;
        }

        if (line_end - line_start >= sizeof("populated") - 1U &&
            memcmp(data + line_start, "populated",
                   sizeof("populated") - 1U) == 0) {
            key_len = sizeof("populated") - 1U;
            value = &parsed_populated;
            seen = &seen_populated;
        } else if (line_end - line_start >= sizeof("frozen") - 1U &&
                   memcmp(data + line_start, "frozen",
                          sizeof("frozen") - 1U) == 0) {
            key_len = sizeof("frozen") - 1U;
            value = &parsed_frozen;
            seen = &seen_frozen;
        } else {
            return -1;
        }

        if (line_end - line_start != key_len + 2U ||
            data[line_start + key_len] != ' ' ||
            (data[line_start + key_len + 1U] != '0' &&
             data[line_start + key_len + 1U] != '1') || *seen != 0U) {
            return -1;
        }
        *value = data[line_start + key_len + 1U] == '1';
        *seen = 1U;
        index = line_end + 1U;
    }

    if (seen_populated != 1U || seen_frozen != 1U) {
        return -1;
    }
    out->known = true;
    out->populated = parsed_populated;
    out->frozen = parsed_frozen;
    return 0;
}
