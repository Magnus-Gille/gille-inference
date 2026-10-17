#ifndef GI_BOUND_CGROUP_STATE_H
#define GI_BOUND_CGROUP_STATE_H
#include "../observer/cgroup_events.h"
#include <stdint.h>

/* Internal trusted launcher binding, never caller-supplied RPC data. The launcher
 * must independently bind its owned cgroup to the accepted run/unit invocation.
 * A matching inode alone does not authorize stop, cleanup, or admission. */
struct gi_cgroup_binding { uint64_t device; uint64_t inode; };

/* Borrowed directory descriptor. Does not traverse an arbitrary supplied path,
 * kill processes, infer absence from ENOENT, or equate unknown with empty.
 * Checks real cgroup-v2 filesystem, root-owned nonwritable directory and stable
 * bound inode before/after a <=256-byte read of its fixed cgroup.events file.
 * Zero result means parsed known snapshot; failures zero the entire output. */
int gi_read_bound_cgroup_events(int directory_fd, const struct gi_cgroup_binding *binding,
                               struct gi_cgroup_events *out);
#endif
