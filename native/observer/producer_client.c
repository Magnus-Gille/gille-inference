#define _GNU_SOURCE
#include "producer_client.h"
#include "proc_stat.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define GI_PROXY_DIRECTORY "/run/llama-swap-observer"
#define GI_PROXY_SOCKET GI_PROXY_DIRECTORY "/activity.sock"
#define GI_RECEIPT_BOUND 2048U
#define GI_DEADLINE_MS 500U

static bool digest_valid(const char value[65])
{
    for (size_t i = 0; i < 64; ++i)
        if (!((value[i] >= '0' && value[i] <= '9') ||
              (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return value[64] == '\0';
}

static int monotonic_ms(uint64_t *value)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
        (uint64_t)now.tv_sec > (UINT64_MAX - 999U) / 1000U) return -1;
    *value = (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U;
    return 0;
}

static int remaining_ms(uint64_t deadline)
{
    uint64_t now;
    if (monotonic_ms(&now) != 0 || now >= deadline) return 0;
    return (int)(deadline - now); /* deadline is at most 500 ms ahead */
}

static int wait_ready(int fd, short events, uint64_t deadline)
{
    for (;;) {
        int remaining = remaining_ms(deadline);
        if (remaining <= 0) return GI_PRODUCER_EXPIRED;
        struct pollfd pollfd = { .fd = fd, .events = events };
        int result = poll(&pollfd, 1, remaining);
        if (result < 0 && errno == EINTR) continue;
        if (result == 0) return GI_PRODUCER_EXPIRED;
        if (result < 0 || (pollfd.revents & (POLLERR | POLLNVAL)))
            return GI_PRODUCER_UNAVAILABLE;
        if (pollfd.revents & (events | POLLHUP)) return GI_PRODUCER_OK;
    }
}

static bool process_matches(const struct gi_proxy_binding *binding, uint64_t deadline)
{
    char path[64], buffer[8193];
    int length = snprintf(path, sizeof path, "/proc/%u/stat", binding->pid);
    if (length <= 0 || (size_t)length >= sizeof path) return false;
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return false;
    size_t used = 0;
    bool eof = false;
    while (used < sizeof buffer) {
        if (remaining_ms(deadline) <= 0) break;
        ssize_t n = read(fd, buffer + used, sizeof buffer - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) break;
        if (n == 0) { eof = true; break; }
        used += (size_t)n;
    }
    close(fd);
    struct gi_proc_stat process;
    return eof && used <= 8192 && gi_parse_proc_stat(buffer, used, &process) == 0 &&
        process.pid == binding->pid && process.start_ticks == binding->start_ticks;
}

static bool same_inode(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        a->st_uid == b->st_uid && a->st_mode == b->st_mode;
}

static int random_nonce(char nonce[65], uint64_t deadline)
{
    unsigned char bytes[32];
    static const char hex[] = "0123456789abcdef";
    size_t used = 0;
    while (used < sizeof bytes) {
        if (remaining_ms(deadline) <= 0) return -1;
        ssize_t n = getrandom(bytes + used, sizeof bytes - used, GRND_NONBLOCK);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        used += (size_t)n;
    }
    for (size_t i = 0; i < sizeof bytes; ++i) {
        nonce[2 * i] = hex[bytes[i] >> 4];
        nonce[2 * i + 1] = hex[bytes[i] & 15];
    }
    nonce[64] = '\0';
    return 0;
}

static int observe_activity(const struct gi_proxy_binding *binding,
                            const char *producer_id, const char *directory_path,
                            const char *socket_path, struct gi_producer_receipt *out)
{
    if (out == NULL) return GI_PRODUCER_INVALID_BINDING;
    memset(out, 0, sizeof *out);
    if (binding == NULL || binding->pid == 0 || binding->pid > INT_MAX ||
        binding->start_ticks == 0 || !digest_valid(binding->instance_sha256) ||
        !digest_valid(binding->build_sha256) || !digest_valid(binding->config_sha256))
        return GI_PRODUCER_INVALID_BINDING;
    uint64_t started;
    if (monotonic_ms(&started) != 0 || started > UINT64_MAX - GI_DEADLINE_MS)
        return GI_PRODUCER_UNAVAILABLE;
    uint64_t deadline = started + GI_DEADLINE_MS;
    int result = GI_PRODUCER_UNAVAILABLE, fd = -1, directory = -1;
    struct stat parent_before, socket_before, parent_after, socket_after;
    struct gi_producer_receipt receipt;
    char nonce[65], request[75], response[GI_RECEIPT_BOUND + 1];
    if (!process_matches(binding, deadline)) return GI_PRODUCER_IDENTITY_CHANGED;
    directory = open(directory_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0 || fstat(directory, &parent_before) != 0 ||
        parent_before.st_uid != binding->uid || (parent_before.st_mode & 0022) != 0 ||
        fstatat(directory, "activity.sock", &socket_before, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISSOCK(socket_before.st_mode) || socket_before.st_uid != binding->uid) goto done;
    fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) goto done;
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
    if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) {
        if (errno != EINPROGRESS) goto done;
        result = wait_ready(fd, POLLOUT, deadline);
        if (result != 0) goto done;
        int error = 0;
        socklen_t size = sizeof error;
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) != 0 || error != 0) {
            result = GI_PRODUCER_UNAVAILABLE; goto done;
        }
    }
    struct ucred peer;
    socklen_t peer_size = sizeof peer;
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) != 0 ||
        peer_size != sizeof peer || peer.uid != binding->uid ||
        peer.pid != (pid_t)binding->pid) {
        result = GI_PRODUCER_IDENTITY_CHANGED; goto done;
    }
    if (random_nonce(nonce, deadline) != 0) { result = GI_PRODUCER_UNAVAILABLE; goto done; }
    int request_size = snprintf(request, sizeof request, "snapshot %s\n", nonce);
    if (request_size != 74) { result = GI_PRODUCER_UNAVAILABLE; goto done; }
    for (size_t sent = 0; sent < 74;) {
        result = wait_ready(fd, POLLOUT, deadline);
        if (result != 0) goto done;
        ssize_t n = send(fd, request + sent, 74 - sent, MSG_NOSIGNAL);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) { result = GI_PRODUCER_UNAVAILABLE; goto done; }
        sent += (size_t)n;
    }
    size_t used = 0;
    for (;;) {
        result = wait_ready(fd, POLLIN, deadline);
        if (result != 0) goto done;
        ssize_t n = recv(fd, response + used, sizeof response - used, 0);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n < 0) { result = GI_PRODUCER_UNAVAILABLE; goto done; }
        if (n == 0) break;
        used += (size_t)n;
        if (used > GI_RECEIPT_BOUND) { result = GI_PRODUCER_INVALID_RECEIPT; goto done; }
    }
    if (gi_parse_producer_receipt(response, used, &receipt) != 0) {
        result = GI_PRODUCER_INVALID_RECEIPT; goto done;
    }
    if (strcmp(receipt.producer_id, producer_id) != 0 ||
        strcmp(receipt.request_nonce_sha256, nonce) != 0 ||
        strcmp(receipt.instance_sha256, binding->instance_sha256) != 0 ||
        strcmp(receipt.build_sha256, binding->build_sha256) != 0 ||
        strcmp(receipt.config_sha256, binding->config_sha256) != 0 ||
        !process_matches(binding, deadline) || lstat(directory_path, &parent_after) != 0 ||
        !same_inode(&parent_before, &parent_after) ||
        fstatat(directory, "activity.sock", &socket_after, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same_inode(&socket_before, &socket_after)) {
        result = GI_PRODUCER_IDENTITY_CHANGED; goto done;
    }
    if (remaining_ms(deadline) <= 0) { result = GI_PRODUCER_EXPIRED; goto done; }
    *out = receipt;
    result = GI_PRODUCER_OK;
done:
    if (fd >= 0) close(fd);
    if (directory >= 0) close(directory);
    return result;
}

int gi_observe_proxy_activity(const struct gi_proxy_binding *binding,
                             struct gi_producer_receipt *out)
{
    return observe_activity(binding, "llama-swap", GI_PROXY_DIRECTORY, GI_PROXY_SOCKET, out);
}

int gi_observe_runtime_activity(const struct gi_proxy_binding *binding,
                               const char *producer_id, struct gi_producer_receipt *out)
{
    if (out == NULL) return GI_PRODUCER_INVALID_BINDING;
    memset(out, 0, sizeof *out);
    if (producer_id == NULL) return GI_PRODUCER_INVALID_BINDING;
    size_t length = strnlen(producer_id, 65);
    if (length == 0 || length > 64) return GI_PRODUCER_INVALID_BINDING;
    for (size_t i = 0; i < length; ++i) {
        char c = producer_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_'))
            return GI_PRODUCER_INVALID_BINDING;
    }
    char directory[96], path[108];
    int d = snprintf(directory, sizeof directory, "/run/gille-producer-observer-%s", producer_id);
    int p = snprintf(path, sizeof path, "%s/activity.sock", directory);
    if (d <= 0 || (size_t)d >= sizeof directory || p <= 0 || (size_t)p >= sizeof path)
        return GI_PRODUCER_INVALID_BINDING;
    return observe_activity(binding, producer_id, directory, path, out);
}
