#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "arbiter.h"
#include <algorithm>
#include <cerrno>
#include <fcntl.h>
#include <limits>
#include <sys/file.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>

namespace gille::launcher {
namespace {
constexpr const char* directoryPath = "/run/gille-install-arbiter";
bool same(const struct stat& a, const struct stat& b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid &&
        a.st_gid == b.st_gid && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink;
}
bool nowMs(std::uint64_t& result) {
    struct timespec now{};
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
        static_cast<std::uint64_t>(now.tv_sec) > (UINT64_MAX - 999) / 1000) return false;
    result = static_cast<std::uint64_t>(now.tv_sec) * 1000 +
        static_cast<std::uint64_t>(now.tv_nsec) / 1000000;
    return true;
}
}
Arbiter::Arbiter() : process_(getpid()) {
    if (geteuid() != 0) { error_ = Error::identity; return; }
    int run = open("/run", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat root{};
    if (run < 0 || fstat(run, &root) != 0 || root.st_uid != 0 || (root.st_mode & 0022)) {
        if (run >= 0) close(run);
        error_ = Error::identity; return;
    }
    directory_ = openat(run, "gille-install-arbiter", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(run);
    if (directory_ < 0 || fstat(directory_, &parent_) != 0 || parent_.st_uid != 0 ||
        (parent_.st_mode & 07777) != 0700) { error_ = Error::identity; return; }
    lock_ = openat(directory_, "arbiter.lock", O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (lock_ < 0 || fstat(lock_, &inode_) != 0 || !S_ISREG(inode_.st_mode) ||
        inode_.st_uid != 0 || (inode_.st_mode & 07777) != 0600 || inode_.st_nlink != 1 ||
        !identityMatches()) { error_ = Error::identity; return; }
    if (flock(lock_, LOCK_EX | LOCK_NB) != 0) { error_ = Error::lock_busy; return; }
    std::size_t used = 0;
    while (used < instance_.size()) {
        ssize_t n = getrandom(instance_.data() + used, instance_.size() - used, GRND_NONBLOCK);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { error_ = Error::entropy; return; }
        used += static_cast<std::size_t>(n);
    }
    if (!nowMs(lastClock_)) { error_ = Error::clock; return; }
    // No persisted "clean" marker can authorize startup. The host reconciler
    // must re-prove absence/restoration after every broker construction/restart.
    state_ = State::quarantined;
}
Arbiter::~Arbiter() {
    if (lock_ >= 0) close(lock_);
    if (directory_ >= 0) close(directory_);
}
bool Arbiter::identityMatches() const {
    struct stat parent{}, path{}, descriptor{};
    return getpid() == process_ && directory_ >= 0 && lock_ >= 0 && lstat(directoryPath, &parent) == 0 &&
        same(parent_, parent) && fstatat(directory_, "arbiter.lock", &path, AT_SYMLINK_NOFOLLOW) == 0 &&
        same(inode_, path) && fstat(lock_, &descriptor) == 0 && same(inode_, descriptor);
}
void Arbiter::quarantine(Error reason) {
    state_ = State::quarantined;
    error_ = reason;
}
bool Arbiter::refresh(std::uint64_t& now) {
    if (state_ == State::unavailable) return false;
    if (!identityMatches()) { state_ = State::unavailable; error_ = Error::identity; return false; }
    if (!nowMs(now) || now < lastClock_) { quarantine(Error::clock); return false; }
    lastClock_ = now;
    if ((state_ == State::installation || state_ == State::maintenance) && now >= expires_)
        quarantine(Error::expired);
    return true;
}
State Arbiter::check() {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    refresh(now);
    return state_;
}
Error Arbiter::error() {
    std::lock_guard<std::mutex> guard(mutex_);
    return error_;
}
bool Arbiter::acceptReconciliation() {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    if (!refresh(now) || state_ != State::quarantined || activeSequence_ != 0) return false;
    state_ = State::idle; error_ = Error::none;
    return true;
}
bool Arbiter::matches(const Lease& lease) const {
    return lease.sequence_ != 0 && lease.sequence_ == activeSequence_ && lease.instance_ == instance_;
}
Lease Arbiter::acquire(Mode mode, std::uint32_t ttlMs, std::uint64_t ownerDeadlineMs) {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    if (!refresh(now) || state_ != State::idle || ttlMs == 0 || ttlMs > 5000 ||
        (mode != Mode::installation && mode != Mode::maintenance) ||
        ownerDeadlineMs <= now || now > UINT64_MAX - ttlMs) return {};
    if (sequence_ == UINT64_MAX) { quarantine(Error::sequence); return {}; }
    Lease lease;
    lease.instance_ = instance_; lease.sequence_ = ++sequence_;
    activeSequence_ = lease.sequence_;
    ownerDeadline_ = ownerDeadlineMs;
    expires_ = std::min(now + ttlMs, ownerDeadline_);
    state_ = mode == Mode::installation ? State::installation : State::maintenance;
    return lease;
}
bool Arbiter::renew(const Lease& lease, std::uint32_t ttlMs) {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    if (!refresh(now) || (state_ != State::installation && state_ != State::maintenance) ||
        !matches(lease) || ttlMs == 0 || ttlMs > 5000 || now > UINT64_MAX - ttlMs) return false;
    expires_ = std::min(now + ttlMs, ownerDeadline_);
    return true;
}
bool Arbiter::beginRestoration(const Lease& lease) {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    if (!refresh(now) || !matches(lease) || (state_ != State::installation &&
        state_ != State::maintenance && state_ != State::quarantined)) return false;
    state_ = State::restoring;
    return true;
}
bool Arbiter::finishRestoration(const Lease& lease, bool verified) {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    if (!refresh(now) || state_ != State::restoring || !matches(lease)) return false;
    if (!verified) { quarantine(Error::restoration); return false; }
    activeSequence_ = 0; expires_ = 0; ownerDeadline_ = 0;
    state_ = State::idle; error_ = Error::none;
    return true;
}
void Arbiter::revoke() {
    std::lock_guard<std::mutex> guard(mutex_);
    std::uint64_t now;
    if (refresh(now)) quarantine(Error::revoked);
}
}
