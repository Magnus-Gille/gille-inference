#ifndef GI_CGROUP_LIMITS_H
#define GI_CGROUP_LIMITS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct gi_cpu_max {
    uint64_t quota_us;
    uint64_t period_us;
};

int gi_parse_cgroup_limit(const char *data, size_t length, uint64_t *out);
int gi_parse_cpu_max(const char *data, size_t length,
                     struct gi_cpu_max *out);

#ifdef __cplusplus
}
#endif

#endif
