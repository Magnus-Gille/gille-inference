#ifndef GI_CGROUP_EVENTS_H
#define GI_CGROUP_EVENTS_H

#include <stdbool.h>
#include <stddef.h>

struct gi_cgroup_events {
    bool known;
    bool populated;
    bool frozen;
};

int gi_parse_cgroup_events(const char *data, size_t len,
                           struct gi_cgroup_events *out);

#endif
