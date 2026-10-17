#ifndef GI_COUNTERS_H
#define GI_COUNTERS_H

#include <stddef.h>
#include <stdint.h>

int gi_parse_mem_available(const char *data, size_t len, uint64_t *outBytes);
int gi_parse_oom_kill(const char *data, size_t len, uint64_t *out);

#endif
