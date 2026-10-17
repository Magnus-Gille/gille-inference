#ifndef GILLE_RESOURCE_LIMITS_H
#define GILLE_RESOURCE_LIMITS_H
#include "cgroup_state.h"
#include "../observer/cgroup_limits.h"
#ifdef __cplusplus
extern "C" {
#endif
struct gi_resource_limits {
    uint64_t memory_max_bytes;
    uint64_t tasks_max;
    struct gi_cpu_max cpu;
};
/* Internal trusted binding, not a public path or authorization API. Borrowed fd.
 * Returns 0 only for two matching, finite snapshots of the exact owned cgroup.
 * Requires zero swap/burst and grouped OOM. Does not start/release any workload. */
int gi_verify_bound_resource_limits(int directory_fd, const struct gi_cgroup_binding *binding,
                                   const struct gi_resource_limits *expected);
#ifdef __cplusplus
}
#endif
#endif
