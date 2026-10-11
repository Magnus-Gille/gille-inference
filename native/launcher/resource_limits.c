#define _GNU_SOURCE
#include "resource_limits.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

static int same(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
        a->st_uid == b->st_uid && a->st_gid == b->st_gid && b->st_nlink != 0;
}
/* name is one of six constants below; no caller-selected file is read. */
static int fixed_read(int directory, const struct stat *identity, const char *name,
                      char data[64], size_t *length)
{
    struct stat before, after, path, parent;
    int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return -1;
    int result = -1, eof = 0;
    size_t used = 0;
    if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_uid != 0 ||
        before.st_dev != identity->st_dev || (before.st_mode & 0022) != 0 || before.st_nlink == 0) goto done;
    for (unsigned int attempts = 0; attempts < 16 && used < 64; ++attempts) {
        ssize_t n = read(fd, data + used, 64 - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) goto done;
        if (n == 0) { eof = 1; break; }
        used += (size_t)n;
    }
    if (!eof || fstat(fd, &after) != 0 || !same(&before, &after) ||
        fstatat(directory, name, &path, AT_SYMLINK_NOFOLLOW) != 0 || !same(&before, &path) ||
        fstat(directory, &parent) != 0 || !same(identity, &parent)) goto done;
    *length = used;
    result = 0;
done:
    close(fd);
    return result;
}
int gi_verify_bound_resource_limits(int directory_fd, const struct gi_cgroup_binding *binding,
                                   const struct gi_resource_limits *expected)
{
    if (directory_fd < 0 || binding == NULL || expected == NULL || binding->inode == 0 ||
        expected->memory_max_bytes == 0 || expected->tasks_max == 0 || expected->cpu.quota_us == 0 ||
        expected->cpu.period_us < 1000 || expected->cpu.period_us > 1000000) return -1;
    struct stat identity;
    struct statfs filesystem;
    if (fstat(directory_fd, &identity) != 0 || !S_ISDIR(identity.st_mode) || identity.st_uid != 0 ||
        (identity.st_mode & 0022) != 0 || identity.st_nlink == 0 ||
        (uint64_t)identity.st_dev != binding->device || (uint64_t)identity.st_ino != binding->inode ||
        fstatfs(directory_fd, &filesystem) != 0 || filesystem.f_type != CGROUP2_SUPER_MAGIC) return -1;
    const char *const names[] = {"memory.max", "memory.swap.max", "pids.max", "memory.oom.group", "cpu.max.burst"};
    const uint64_t values[] = {expected->memory_max_bytes, 0, expected->tasks_max, 1, 0};
    for (unsigned int pass = 0; pass < 2; ++pass) {
        for (size_t i = 0; i < sizeof names / sizeof names[0]; ++i) {
            char data[64]; size_t length; uint64_t value;
            if (fixed_read(directory_fd, &identity, names[i], data, &length) != 0 ||
                gi_parse_cgroup_limit(data, length, &value) != 0 || value != values[i]) return -1;
        }
        char data[64]; size_t length; struct gi_cpu_max cpu;
        if (fixed_read(directory_fd, &identity, "cpu.max", data, &length) != 0 ||
            gi_parse_cpu_max(data, length, &cpu) != 0 || cpu.quota_us != expected->cpu.quota_us ||
            cpu.period_us != expected->cpu.period_us) return -1;
    }
    return 0;
}
