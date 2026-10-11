#define _GNU_SOURCE
/* Synthetic CI executable only. No caller-controlled path or command. */
#include "../observer/producer_client.h"
#include "../observer/proc_stat.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static uint64_t start_ticks(uint32_t pid)
{
    char path[64], data[8193];
    if (snprintf(path, sizeof path, "/proc/%u/stat", pid) <= 0) return 0;
    FILE *file = fopen(path, "r");
    if (file == NULL) return 0;
    size_t count = fread(data, 1, sizeof data, file);
    int ended = feof(file), failed = ferror(file);
    fclose(file);
    struct gi_proc_stat process;
    if (!ended || failed || count > 8192 || gi_parse_proc_stat(data, count, &process) != 0)
        return 0;
    return process.start_ticks;
}

static int all_zero(const struct gi_producer_receipt *receipt)
{
    const unsigned char *bytes = (const unsigned char *)receipt;
    for (size_t i = 0; i < sizeof *receipt; ++i) if (bytes[i] != 0) return 0;
    return 1;
}

int main(int argc, char **argv)
{
    if (argc != 3 || geteuid() != 65534) return 2;
    char *end;
    errno = 0;
    unsigned long pid = strtoul(argv[2], &end, 10);
    if (errno || *end != '\0' || end == argv[2] || pid == 0 || pid > 2147483647UL) return 2;
    struct gi_proxy_binding binding = { .uid = 0, .pid = (uint32_t)pid };
    binding.start_ticks = start_ticks(binding.pid);
    if (binding.start_ticks == 0) return 2;
    memset(binding.instance_sha256, 'a', 64);
    memset(binding.build_sha256, 'b', 64);
    memset(binding.config_sha256, 'c', 64);
    const char *mode = argv[1];
    int expected = GI_PRODUCER_OK;
    if (strcmp(mode, "peer-pid") == 0) {
        binding.pid = (uint32_t)getpid();
        binding.start_ticks = start_ticks(binding.pid);
        expected = GI_PRODUCER_IDENTITY_CHANGED;
    } else if (strcmp(mode, "peer-uid") == 0) {
        binding.uid = 1; expected = GI_PRODUCER_IDENTITY_CHANGED;
    } else if (strcmp(mode, "start") == 0) {
        ++binding.start_ticks; expected = GI_PRODUCER_IDENTITY_CHANGED;
    } else if (strcmp(mode, "build") == 0) {
        binding.build_sha256[0] = 'd'; expected = GI_PRODUCER_IDENTITY_CHANGED;
    } else if (strcmp(mode, "config") == 0) {
        binding.config_sha256[0] = 'd'; expected = GI_PRODUCER_IDENTITY_CHANGED;
    } else if (strcmp(mode, "instance") == 0) {
        binding.instance_sha256[0] = 'd'; expected = GI_PRODUCER_IDENTITY_CHANGED;
    } else if (strcmp(mode, "malformed") == 0 || strcmp(mode, "oversize") == 0) {
        expected = GI_PRODUCER_INVALID_RECEIPT;
    } else if (strcmp(mode, "timeout") == 0) expected = GI_PRODUCER_EXPIRED;
    else if (strcmp(mode, "path-changed") == 0) expected = GI_PRODUCER_IDENTITY_CHANGED;
    else if (strcmp(mode, "busy") != 0 && strcmp(mode, "idle") != 0 &&
             strcmp(mode, "unknown") != 0 && strcmp(mode, "replay") != 0) return 2;
    struct gi_producer_receipt receipt;
    memset(&receipt, 0xa5, sizeof receipt);
    int result = gi_observe_proxy_activity(&binding, &receipt);
    if (result != expected) { puts("native-producer-result: FAIL"); return 1; }
    if (result != 0) return all_zero(&receipt) ? 0 : 1;
    if (strcmp(mode, "unknown") == 0)
        return !receipt.known && receipt.active == 0 && receipt.queued == 0 &&
            receipt.loading == 0 && receipt.work_started == 0 ? 0 : 1;
    if (!receipt.known) return 1;
    if (strcmp(mode, "busy") == 0)
        return receipt.active == 1 && receipt.queued == 1 && receipt.loading == 1 &&
            receipt.work_started == 3 ? 0 : 1;
    if (strcmp(mode, "replay") == 0) {
        result = gi_observe_proxy_activity(&binding, &receipt);
        return result == GI_PRODUCER_IDENTITY_CHANGED && all_zero(&receipt) ? 0 : 1;
    }
    return receipt.active == 0 && receipt.queued == 0 && receipt.loading == 0 &&
        receipt.work_started == 1 ? 0 : 1;
}
