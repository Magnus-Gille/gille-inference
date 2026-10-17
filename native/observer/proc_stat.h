#ifndef GI_PROC_STAT_H
#define GI_PROC_STAT_H

#include <stddef.h>
#include <stdint.h>

struct gi_proc_stat {
    uint32_t pid;
    uint64_t flags;
    uint64_t start_ticks;
};

int gi_parse_proc_stat(const char *data, size_t len, struct gi_proc_stat *out);

#endif
