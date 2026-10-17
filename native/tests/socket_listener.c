#define _POSIX_C_SOURCE 200809L

/*
 * Disposable observer-confinement fixture.  This process has no peer-data
 * protocol: it only keeps two fixed AF_UNIX stream listeners alive and closes
 * accepted connections.
 */

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

enum {
    LISTEN_BACKLOG = 4,
    POLL_TIMEOUT_MS = 20000,
    MAX_ACCEPTS_PER_POLL = 64
};

static const char fixed_path[] = "/run/gi-observer-fixture/peers/forbidden.sock";
static const char ready_path[] = "/run/gi-observer-fixture/peers/socket.ready";
#ifdef __linux__
static const char abstract_name[] = "gi-observer-fixture-denied";
#endif

static volatile sig_atomic_t stop_requested;

static void request_stop(int signal_number)
{
    (void)signal_number;
    stop_requested = 1;
}

static int install_signal_handlers(void)
{
    struct sigaction action;

    memset(&action, 0, sizeof action);
    action.sa_handler = request_stop;
    if (sigemptyset(&action.sa_mask) != 0) return -1;
    if (sigaction(SIGINT, &action, NULL) != 0) return -1;
    if (sigaction(SIGTERM, &action, NULL) != 0) return -1;
    return 0;
}

static int make_nonblocking_cloexec(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) return -1;
    flags = fcntl(fd, F_GETFD, 0);
    if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0) return -1;
    return 0;
}

static int create_listener(const struct sockaddr_un *address, socklen_t address_length,
    int *bound)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (bound != NULL) *bound = 0;
    if (fd < 0) return -1;
    if (make_nonblocking_cloexec(fd) != 0 ||
        bind(fd, (const struct sockaddr *)address, address_length) != 0) {
        close(fd);
        return -1;
    }
    if (bound != NULL) *bound = 1;
    if (listen(fd, LISTEN_BACKLOG) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int create_path_listener(int *bound)
{
    struct sockaddr_un address;
    const size_t path_length = sizeof fixed_path - 1;

    if (path_length >= sizeof address.sun_path) return -1;
    memset(&address, 0, sizeof address);
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, fixed_path, sizeof fixed_path);
    return create_listener(&address,
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_length + 1), bound);
}

#ifdef __linux__
static int create_abstract_listener(void)
{
    struct sockaddr_un address;
    const size_t name_length = sizeof abstract_name - 1;

    if (name_length + 1 >= sizeof address.sun_path) return -1;
    memset(&address, 0, sizeof address);
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path + 1, abstract_name, name_length);
    return create_listener(&address,
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) + name_length + 1), NULL);
}
#else
static int create_abstract_listener(void)
{
    return -1;
}
#endif

static int remove_owned_path(const char *path, int owned)
{
    if (!owned || unlink(path) == 0 || errno == ENOENT) return 0;
    return -1;
}

static int cleanup(int path_fd, int abstract_fd, int path_bound, int ready_created)
{
    int result = 0;

    if (abstract_fd >= 0 && close(abstract_fd) != 0) result = -1;
    if (path_fd >= 0 && close(path_fd) != 0) result = -1;
    if (remove_owned_path(ready_path, ready_created) != 0) result = -1;
    if (remove_owned_path(fixed_path, path_bound) != 0) result = -1;
    return result;
}

static int remaining_milliseconds(const struct timespec *started)
{
    struct timespec now;
    long long elapsed;

    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    elapsed = (long long)(now.tv_sec - started->tv_sec) * 1000LL;
    elapsed += (long long)(now.tv_nsec - started->tv_nsec) / 1000000LL;
    if (elapsed >= POLL_TIMEOUT_MS) return 0;
    if (elapsed < 0) return POLL_TIMEOUT_MS;
    return (int)(POLL_TIMEOUT_MS - elapsed);
}

static int accept_and_close(int fd)
{
    int accepted = 0;

    while (accepted < MAX_ACCEPTS_PER_POLL) {
        int peer = accept(fd, NULL, NULL);
        if (peer >= 0) {
            if (close(peer) != 0) return -1;
            ++accepted;
            continue;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        return -1;
    }
    return 0;
}

static int serve_for_bounded_period(int path_fd, int abstract_fd)
{
    struct pollfd descriptors[2] = {
        {path_fd, POLLIN, 0},
        {abstract_fd, POLLIN, 0}
    };
    struct timespec started;

    if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) return -1;
    while (!stop_requested) {
        int timeout = remaining_milliseconds(&started);
        int result;

        if (timeout < 0) return -1;
        if (timeout == 0) return 0;
        result = poll(descriptors, 2, timeout);
        if (result == 0) return 0;
        if (result < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        for (size_t i = 0; i < 2; ++i) {
            if ((descriptors[i].revents & (POLLNVAL | POLLERR)) != 0) return -1;
            if ((descriptors[i].revents & (POLLIN | POLLHUP)) != 0 &&
                accept_and_close(descriptors[i].fd) != 0) return -1;
        }
    }
    return 0;
}

int main(int argc, char **argv)
{
    int path_fd = -1;
    int abstract_fd = -1;
    int ready_fd = -1;
    int path_bound = 0;
    int ready_created = 0;
    int result = 1;

    (void)argv;
    if (argc != 1 || getuid() == 0 || geteuid() == 0) return 2;
    if (install_signal_handlers() != 0) return 1;

    path_fd = create_path_listener(&path_bound);
    if (path_fd < 0) goto done;
    abstract_fd = create_abstract_listener();
    if (abstract_fd < 0) goto done;
    if (chmod(fixed_path, 0666) != 0) goto done;
    ready_fd = open(ready_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (ready_fd < 0) goto done;
    ready_created = 1;
    if (close(ready_fd) != 0) {
        ready_fd = -1;
        goto done;
    }
    ready_fd = -1;
    result = serve_for_bounded_period(path_fd, abstract_fd) == 0 ? 0 : 1;

done:
    if (ready_fd >= 0 && close(ready_fd) != 0) result = 1;
    if (cleanup(path_fd, abstract_fd, path_bound, ready_created) != 0) result = 1;
    return result;
}
