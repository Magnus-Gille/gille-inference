#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "endpoint.h"
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <poll.h>
#include <system_error>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace gille::producer {
namespace {
using Clock = std::chrono::steady_clock;
bool same(const struct stat& a, const struct stat& b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino &&
        a.st_uid == b.st_uid && a.st_mode == b.st_mode;
}
bool ready(int fd, short events, Clock::time_point deadline, const std::atomic<bool>& stop) {
    while (!stop.load()) {
        auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        if (left <= 0) return false;
        struct pollfd p{fd, events, 0};
        int result = poll(&p, 1, static_cast<int>(left > 50 ? 50 : left));
        if (result < 0 && errno == EINTR) continue;
        if (result < 0 || (p.revents & (POLLERR | POLLNVAL))) return false;
        if (result > 0 && (p.revents & (events | POLLHUP))) return true;
    }
    return false;
}
}

Endpoint::Endpoint(Activity& activity, const Identity& identity, std::uint32_t observerUid)
    : activity_(activity), identity_(identity), observerUid_(observerUid) {}
Endpoint::~Endpoint() { close(); }

void Endpoint::fail(EndpointError reason) {
    EndpointError expected = EndpointError::none;
    error_.compare_exchange_strong(expected, reason);
    activity_.invalidate();
    stop_.store(true);
}

bool Endpoint::pathMatches() const {
    struct stat parent{}, socket{};
    return directory_ >= 0 && lstat(directoryPath_.data(), &parent) == 0 &&
        same(parent_, parent) &&
        fstatat(directory_, "activity.sock", &socket, AT_SYMLINK_NOFOLLOW) == 0 &&
        same(socket_, socket);
}

bool Endpoint::start() {
    if (attempted_) return false;
    attempted_ = true;
    Receipt validation;
    std::array<char, 65> nonce{};
    nonce.fill('0'); nonce[64] = '\0';
    if (observerUid_ == std::numeric_limits<std::uint32_t>::max() ||
        !encodeReceipt(identity_, Snapshot{}, nonce, validation)) {
        fail(EndpointError::configuration); return false;
    }
    int n = std::snprintf(directoryPath_.data(), directoryPath_.size(),
                          "/run/gille-producer-observer-%s", identity_.producerId.data());
    int p = std::snprintf(path_.data(), path_.size(), "%s/activity.sock", directoryPath_.data());
    if (n <= 0 || static_cast<std::size_t>(n) >= directoryPath_.size() ||
        p <= 0 || static_cast<std::size_t>(p) >= path_.size()) {
        fail(EndpointError::configuration); return false;
    }
    int run = open("/run", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat runStat{};
    if (run < 0 || fstat(run, &runStat) != 0 || runStat.st_uid != 0 || (runStat.st_mode & 0022)) {
        if (run >= 0) ::close(run);
        fail(EndpointError::directory); return false;
    }
    directory_ = openat(run, directoryPath_.data() + 5,
                         O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    ::close(run);
    if (directory_ < 0 || fstat(directory_, &parent_) != 0 ||
        parent_.st_uid != geteuid() || (parent_.st_mode & 0022)) {
        fail(EndpointError::directory); close(); return false;
    }
    listener_ = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    struct sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path_.data(), static_cast<std::size_t>(p) + 1);
    if (listener_ < 0 || bind(listener_, reinterpret_cast<struct sockaddr*>(&address), sizeof address) != 0) {
        fail(EndpointError::socket); close(); return false;
    }
    // Never adopt/remove an existing endpoint. Capture only the socket just bound.
    if (fstatat(directory_, "activity.sock", &socket_, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISSOCK(socket_.st_mode) || socket_.st_uid != geteuid()) {
        fail(EndpointError::socket); close(); return false;
    }
    ownsSocket_ = true;
    if (!pathMatches() || fchmodat(directory_, "activity.sock", 0666, 0) != 0) {
        fail(EndpointError::socket); close(); return false;
    }
    socket_.st_mode = (socket_.st_mode & ~07777) | 0666;
    if (!pathMatches() || listen(listener_, 8) != 0) {
        fail(EndpointError::socket); close(); return false;
    }
    try { worker_ = std::thread(&Endpoint::run, this); }
    catch (const std::system_error&) { fail(EndpointError::worker); close(); return false; }
    return true;
}

void Endpoint::serve(int client) {
    auto deadline = Clock::now() + std::chrono::milliseconds(500);
    struct ucred peer{};
    socklen_t size = sizeof peer;
    if (getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0 ||
        size != sizeof peer || peer.uid != observerUid_) return;
    std::array<char, 75> request{};
    std::size_t used = 0;
    while (used < 74) {
        if (!ready(client, POLLIN, deadline, stop_)) return;
        ssize_t n = recv(client, request.data() + used, request.size() - used, 0);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) return;
        used += static_cast<std::size_t>(n);
    }
    if (used != 74 || std::memcmp(request.data(), "snapshot ", 9) != 0 || request[73] != '\n') return;
    std::array<char, 65> nonce{};
    for (std::size_t i = 0; i < 64; ++i) {
        char c = request[9 + i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return;
        nonce[i] = c;
    }
    if (!pathMatches()) { fail(EndpointError::socket); return; }
    Receipt receipt;
    if (!encodeReceipt(identity_, activity_.snapshot(), nonce, receipt)) {
        fail(EndpointError::worker); return;
    }
    for (std::size_t sent = 0; sent < receipt.size;) {
        if (!ready(client, POLLOUT, deadline, stop_)) return;
        ssize_t n = send(client, receipt.bytes.data() + sent, receipt.size - sent, MSG_NOSIGNAL);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) return;
        sent += static_cast<std::size_t>(n);
    }
}

void Endpoint::run() {
    while (!stop_.load()) {
        struct pollfd p{listener_, POLLIN, 0};
        int result = poll(&p, 1, 50);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0 || (p.revents & (POLLERR | POLLHUP | POLLNVAL))) {
            fail(EndpointError::worker); return;
        }
        if (result == 0) continue;
        int client = accept4(listener_, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (client < 0) {
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK || errno == ECONNABORTED) continue;
            fail(EndpointError::worker); return;
        }
        serve(client);
        ::close(client);
    }
}

bool Endpoint::close() {
    activity_.invalidate();
    stop_.store(true);
    attempted_ = true;
    if (worker_.joinable()) worker_.join();
    if (listener_ >= 0) { ::close(listener_); listener_ = -1; }
    if (ownsSocket_) {
        if (!pathMatches() || unlinkat(directory_, "activity.sock", 0) != 0)
            fail(EndpointError::cleanup);
        ownsSocket_ = false;
    }
    if (directory_ >= 0) { ::close(directory_); directory_ = -1; }
    return error_.load() == EndpointError::none;
}
}
