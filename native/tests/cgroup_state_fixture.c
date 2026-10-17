#define _GNU_SOURCE
/* Own synthetic cgroups in a fresh hosted VM only. This is not a production stop API. */
#include "../launcher/cgroup_state.h"
#include "../launcher/resource_limits.h"
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "cgroup fixture failed: %s\n", #x); goto cleanup; } } while (0)
static uint64_t now_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0) return 0;
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}
static void pause_ms(void) { struct timespec delay = {0, 10000000}; nanosleep(&delay, NULL); }
static int env_is(const char *key, const char *expected) {
    const char *value = getenv(key); return value != NULL && strcmp(value, expected) == 0;
}
static int same_inode(int fd, const struct stat *expected) {
    struct stat current;
    return fstat(fd, &current) == 0 && current.st_dev == expected->st_dev &&
        current.st_ino == expected->st_ino && current.st_uid == 0 && current.st_nlink != 0;
}
static int write_fixed(int directory, const char *file, const char *value, size_t length) {
    int fd = openat(directory, file, O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t result = write(fd, value, length);
    close(fd);
    return result == (ssize_t)length ? 0 : -1;
}
static int expect_population(int fd, const struct gi_cgroup_binding *binding, int populated) {
    uint64_t started = now_ms();
    if (started == 0) return -1;
    do {
        struct gi_cgroup_events events;
        if (gi_read_bound_cgroup_events(fd, binding, &events) != 0 || !events.known) return -1;
        if (events.populated == (populated != 0)) return 0;
        pause_ms();
    } while (now_ms() - started < 2000);
    return -1;
}
static int unknown(int fd, const struct gi_cgroup_binding *binding) {
    struct gi_cgroup_events events;
    memset(&events, 0xa5, sizeof events);
    if (gi_read_bound_cgroup_events(fd, binding, &events) == 0) return 0;
    const unsigned char *p = (const unsigned char *)&events;
    for (size_t i = 0; i < sizeof events; ++i) if (p[i] != 0) return 0;
    return 1;
}
int main(void) {
    if (geteuid() != 0 || !env_is("GITHUB_ACTIONS", "true") ||
        !env_is("RUNNER_ENVIRONMENT", "github-hosted")) return 2;
    int result = 1, root = -1, tree = -1, leaf = -1, fake = -1;
    int created = 0, nested = 0, fake_created = 0, fake_file = 0;
    int gate[2] = {-1, -1}, receipt[2] = {-1, -1};
    pid_t child = -1, descendant = -1;
    struct stat identity = {0}, leaf_identity = {0}, fake_identity = {0};
    char name[80], fake_path[128];
    snprintf(name, sizeof name, "gi-install-cgroup-fixture-%ld", (long)getpid());
    snprintf(fake_path, sizeof fake_path, "/tmp/gi-install-cgroup-forgery-%ld", (long)getpid());
    struct gi_cgroup_binding binding;
    CHECK(prctl(PR_SET_CHILD_SUBREAPER, 1) == 0);
    root = open("/sys/fs/cgroup", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    CHECK(root >= 0);
    CHECK(mkdirat(root, name, 0755) == 0); created = 1;
    tree = openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    CHECK(tree >= 0 && fstat(tree, &identity) == 0);
    binding = (struct gi_cgroup_binding){(uint64_t)identity.st_dev, (uint64_t)identity.st_ino};
    CHECK(expect_population(tree, &binding, 0) == 0);
    const struct gi_resource_limits limits = {67108864, 8, {25000, 100000}};
    /* Only this newly owned group is configured; never enable host-wide controllers. */
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &limits) != 0);
    CHECK(write_fixed(tree, "memory.max", "67108864", 8) == 0);
    CHECK(write_fixed(tree, "memory.swap.max", "0", 1) == 0);
    CHECK(write_fixed(tree, "pids.max", "8", 1) == 0);
    CHECK(write_fixed(tree, "memory.oom.group", "1", 1) == 0);
    CHECK(write_fixed(tree, "cpu.max", "25000 100000", 12) == 0);
    CHECK(write_fixed(tree, "cpu.max.burst", "0", 1) == 0);
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &limits) == 0);
    struct gi_resource_limits wrong_limits = limits; wrong_limits.tasks_max = 16;
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &wrong_limits) != 0);
    wrong_limits = limits; wrong_limits.cpu.quota_us = 50000;
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &wrong_limits) != 0);
    wrong_limits = limits; wrong_limits.cpu.period_us = 200000;
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &wrong_limits) != 0);
    wrong_limits = limits; wrong_limits.memory_max_bytes = 33554432;
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &wrong_limits) != 0);
    CHECK(write_fixed(tree, "memory.swap.max", "4096", 4) == 0);
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &limits) != 0);
    CHECK(write_fixed(tree, "memory.swap.max", "0", 1) == 0);
    CHECK(write_fixed(tree, "memory.oom.group", "0", 1) == 0);
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &limits) != 0);
    CHECK(write_fixed(tree, "memory.oom.group", "1", 1) == 0);
    CHECK(write_fixed(tree, "cpu.max.burst", "1000", 4) == 0);
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &limits) != 0);
    CHECK(write_fixed(tree, "cpu.max.burst", "0", 1) == 0);
    struct gi_cgroup_binding wrong = binding; ++wrong.inode;
    CHECK(unknown(tree, &wrong));
    CHECK(gi_verify_bound_resource_limits(tree, &wrong, &limits) != 0);
    CHECK(mkdir(fake_path, 0700) == 0); fake_created = 1;
    fake = open(fake_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    CHECK(fake >= 0 && fstat(fake, &fake_identity) == 0);
    int forged = openat(fake, "cgroup.events", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    CHECK(forged >= 0); fake_file = 1;
    const char content[] = "populated 0\nfrozen 0\n";
    int forged_ok = write(forged, content, sizeof content - 1) == (ssize_t)(sizeof content - 1);
    close(forged); CHECK(forged_ok);
    struct gi_cgroup_binding fake_binding = {(uint64_t)fake_identity.st_dev, (uint64_t)fake_identity.st_ino};
    CHECK(unknown(fake, &fake_binding));
    CHECK(gi_verify_bound_resource_limits(fake, &fake_binding, &limits) != 0);
    CHECK(mkdirat(tree, "nested", 0755) == 0); nested = 1;
    leaf = openat(tree, "nested", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    CHECK(leaf >= 0 && fstat(leaf, &leaf_identity) == 0);
    CHECK(pipe2(gate, O_CLOEXEC) == 0 && pipe2(receipt, O_CLOEXEC) == 0);
    child = fork(); CHECK(child >= 0);
    if (child == 0) {
        close(gate[1]); close(receipt[0]);
        close(root); close(tree); close(leaf); close(fake);
        char go;
        if (read(gate[0], &go, 1) != 1 || go != 'x' || setgroups(0, NULL) != 0 ||
            setgid(65534) != 0 || setuid(65534) != 0) _exit(21);
        close(gate[0]);
        pid_t grandchild = fork();
        if (grandchild < 0) _exit(22);
        if (grandchild == 0) { close(receipt[1]); for (;;) pause(); }
        if (write(receipt[1], &grandchild, sizeof grandchild) != sizeof grandchild) _exit(23);
        close(receipt[1]);
        for (;;) pause();
    }
    close(gate[0]); gate[0] = -1; close(receipt[1]); receipt[1] = -1;
    char pid_text[32]; int length = snprintf(pid_text, sizeof pid_text, "%ld", (long)child);
    CHECK(length > 0 && (size_t)length < sizeof pid_text);
    CHECK(write_fixed(leaf, "cgroup.procs", pid_text, (size_t)length) == 0);
    /* Child is still blocked on the gate; release only after rereading actual limits. */
    CHECK(gi_verify_bound_resource_limits(tree, &binding, &limits) == 0);
    CHECK(write(gate[1], "x", 1) == 1); close(gate[1]); gate[1] = -1;
    struct pollfd ready = {receipt[0], POLLIN, 0};
    CHECK(poll(&ready, 1, 2000) > 0);
    CHECK(read(receipt[0], &descendant, sizeof descendant) == sizeof descendant && descendant > 0);
    close(receipt[0]); receipt[0] = -1;
    CHECK(expect_population(tree, &binding, 1) == 0);
    int procs = openat(tree, "cgroup.procs", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    CHECK(procs >= 0);
    char first; ssize_t root_processes = read(procs, &first, 1); close(procs);
    CHECK(root_processes == 0); /* descendant work must still make the ancestor populated */
    CHECK(same_inode(tree, &identity));
    CHECK(write_fixed(tree, "cgroup.kill", "1", 1) == 0);
    CHECK(expect_population(tree, &binding, 0) == 0);
    puts("owned subtree: exact resource limits before gate, descendant work, known empty after kill");
    result = 0;
cleanup:
    if (child > 0 && tree >= 0 && same_inode(tree, &identity))
        if (write_fixed(tree, "cgroup.kill", "1", 1) != 0) result = 1;
    if (child > 0) kill(child, SIGKILL);
    if (descendant > 0) kill(descendant, SIGKILL);
    uint64_t deadline = now_ms() + 2000;
    for (;;) {
        int status;
        pid_t reaped = waitpid(-1, &status, WNOHANG);
        if (reaped > 0) continue;
        if (reaped < 0 && errno == ECHILD) break;
        if (now_ms() >= deadline) { result = 1; break; }
        pause_ms();
    }
    for (size_t i = 0; i < 2; ++i) { if (gate[i] >= 0) close(gate[i]); if (receipt[i] >= 0) close(receipt[i]); }
    if (nested && !(leaf >= 0 && same_inode(leaf, &leaf_identity) && unlinkat(tree, "nested", AT_REMOVEDIR) == 0)) result = 1;
    if (leaf >= 0) close(leaf);
    if (created && !(tree >= 0 && same_inode(tree, &identity) && unlinkat(root, name, AT_REMOVEDIR) == 0)) result = 1;
    if (tree >= 0) close(tree);
    if (root >= 0) close(root);
    if (fake_file && !(fake >= 0 && same_inode(fake, &fake_identity) && unlinkat(fake, "cgroup.events", 0) == 0)) result = 1;
    if (fake_created && !(fake >= 0 && same_inode(fake, &fake_identity) && rmdir(fake_path) == 0)) result = 1;
    if (fake >= 0) close(fake);
    return result;
}
