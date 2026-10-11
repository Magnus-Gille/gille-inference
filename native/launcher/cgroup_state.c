#define _GNU_SOURCE
#include "cgroup_state.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

static int same(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_uid == b->st_uid &&
        a->st_gid == b->st_gid && a->st_mode == b->st_mode && b->st_nlink != 0;
}
int gi_read_bound_cgroup_events(int directory_fd, const struct gi_cgroup_binding *binding,
                               struct gi_cgroup_events *out)
{
    if (out == NULL) return -1;
    memset(out, 0, sizeof *out);
    if (binding == NULL || binding->inode == 0 || directory_fd < 0) return -1;
    struct stat before, after, file_before, file_after, file_path;
    struct statfs filesystem;
    if (fstat(directory_fd, &before) != 0 || !S_ISDIR(before.st_mode) || before.st_uid != 0 ||
        (before.st_mode & 0022) != 0 || before.st_nlink == 0 ||
        (uint64_t)before.st_dev != binding->device || (uint64_t)before.st_ino != binding->inode ||
        fstatfs(directory_fd, &filesystem) != 0 || filesystem.f_type != CGROUP2_SUPER_MAGIC) return -1;
    int fd = openat(directory_fd, "cgroup.events", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return -1;
    int result = -1;
    char data[257];
    size_t used = 0;
    int eof = 0;
    struct gi_cgroup_events parsed;
    if (fstat(fd, &file_before) != 0 || !S_ISREG(file_before.st_mode) ||
        file_before.st_uid != 0 || file_before.st_dev != before.st_dev ||
        (file_before.st_mode & 0022) != 0 || file_before.st_nlink == 0) goto done;
    for (unsigned int attempts = 0; attempts < 16 && used < sizeof data; ++attempts) {
        ssize_t n = read(fd, data + used, sizeof data - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) goto done;
        if (n == 0) { eof = 1; break; }
        used += (size_t)n;
    }
    if (!eof || used > 256 || gi_parse_cgroup_events(data, used, &parsed) != 0 ||
        fstat(directory_fd, &after) != 0 || !same(&before, &after) ||
        fstat(fd, &file_after) != 0 || !same(&file_before, &file_after) ||
        fstatat(directory_fd, "cgroup.events", &file_path, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same(&file_before, &file_path)) goto done;
    *out = parsed;
    result = 0;
done:
    close(fd);
    return result;
}
