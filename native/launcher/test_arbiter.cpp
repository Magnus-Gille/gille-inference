#include "arbiter.h"

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <time.h>
#include <atomic>
#include <thread>

namespace {

using gille::launcher::Arbiter;
using gille::launcher::Error;
using gille::launcher::Lease;
using gille::launcher::Mode;
using gille::launcher::State;

constexpr char kDirectory[] = "/run/gille-install-arbiter";
constexpr char kLock[] = "/run/gille-install-arbiter/arbiter.lock";

bool check(bool condition, const char* expression, const char* file, int line) {
    if (!condition) {
        std::fprintf(stderr, "FAIL %s:%d: %s\n", file, line, expression);
        return false;
    }
    return true;
}

#define CHECK(expression) \
    do { \
        if (!check((expression), #expression, __FILE__, __LINE__)) return false; \
    } while (false)

std::uint64_t monotonicMs() {
    struct timespec now {};
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
    return static_cast<std::uint64_t>(now.tv_sec) * 1000U +
           static_cast<std::uint64_t>(now.tv_nsec) / 1000000U;
}

void sleepMs(unsigned milliseconds) {
    struct timespec delay {
        static_cast<time_t>(milliseconds / 1000U),
        static_cast<long>(milliseconds % 1000U) * 1000000L,
    };
    while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {
    }
}

bool waitPast(std::uint64_t deadlineMs) {
    for (;;) {
        const std::uint64_t now = monotonicMs();
        CHECK(now != 0);
        if (now >= deadlineMs) return true;
        sleepMs(20);
    }
}

bool sameInode(const struct stat& left, const struct stat& right) {
    return left.st_dev == right.st_dev && left.st_ino == right.st_ino;
}

bool safeDirectory(const struct stat& stat) {
    return S_ISDIR(stat.st_mode) && (stat.st_mode & 07777U) == 0700U &&
           stat.st_uid == 0 && stat.st_gid == 0;
}

bool safeLock(const struct stat& stat) {
    return S_ISREG(stat.st_mode) && (stat.st_mode & 07777U) == 0600U &&
           stat.st_uid == 0 && stat.st_gid == 0 && stat.st_nlink == 1;
}

struct Fixture final {
    bool createdDirectory = false;
    bool createdLock = false;
    struct stat directoryIdentity {};
    struct stat lockIdentity {};

    bool prepare() {
        struct stat directory {};
        CHECK(lstat(kDirectory, &directory) != 0 && errno == ENOENT);
        CHECK(mkdir(kDirectory, 0700) == 0);
        createdDirectory = true;
        CHECK(lstat(kDirectory, &directoryIdentity) == 0 && safeDirectory(directoryIdentity));
        const int descriptor = open(kLock, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
        CHECK(descriptor >= 0);
        createdLock = true;
        CHECK(fstat(descriptor, &lockIdentity) == 0);
        CHECK(close(descriptor) == 0);
        CHECK(safeLock(lockIdentity));
        return true;
    }

    bool cleanup() {
        bool okay = true;
        struct stat current {};
        if (createdLock) {
            if (lstat(kLock, &current) == 0 && sameInode(current, lockIdentity) && safeLock(current)) {
                if (unlink(kLock) != 0) okay = false;
                else createdLock = false;
            } else okay = false;
        }
        if (createdDirectory) {
            if (lstat(kDirectory, &current) == 0 && sameInode(current, directoryIdentity) && safeDirectory(current)) {
                if (rmdir(kDirectory) != 0) okay = false;
                else createdDirectory = false;
            } else okay = false;
        }
        return okay;
    }
    ~Fixture() {
        if (!cleanup()) std::fputs("owned fixture cleanup incomplete; preserving unknown paths\n", stderr);
    }

};

bool makeIdle(Arbiter& arbiter) {
    CHECK(arbiter.check() == State::quarantined);
    CHECK(arbiter.error() == Error::none);
    CHECK(arbiter.acceptReconciliation());
    CHECK(arbiter.check() == State::idle);
    return true;
}

Lease acquire(Arbiter& arbiter, Mode mode, std::uint32_t ttlMs = 1000) {
    return arbiter.acquire(mode, ttlMs, monotonicMs() + 3000);
}

bool testStartupQuarantine() {
    Arbiter arbiter;
    CHECK(arbiter.check() == State::quarantined);
    CHECK(arbiter.error() == Error::none);
    CHECK(!arbiter.acquire(Mode::installation, 1000, monotonicMs() + 3000));
    CHECK(arbiter.check() == State::quarantined);
    CHECK(arbiter.acceptReconciliation());
    CHECK(arbiter.check() == State::idle);
    return true;
}

bool testAcquisitionOrder(Mode first, Mode second) {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));

    Lease firstLease = acquire(arbiter, first);
    CHECK(static_cast<bool>(firstLease));
    CHECK(arbiter.check() == (first == Mode::installation ? State::installation
                                                            : State::maintenance));
    CHECK(!arbiter.acquire(second, 1000, monotonicMs() + 3000));

    arbiter.revoke();
    CHECK(arbiter.check() == State::quarantined);
    CHECK(!arbiter.acceptReconciliation());
    CHECK(arbiter.beginRestoration(firstLease));
    CHECK(arbiter.finishRestoration(firstLease, true));
    Lease secondLease = acquire(arbiter, second);
    CHECK(static_cast<bool>(secondLease));
    CHECK(arbiter.check() == (second == Mode::installation ? State::installation
                                                             : State::maintenance));
    arbiter.revoke();
    CHECK(arbiter.check() == State::quarantined);
    return true;
}

bool testSecondObjectIsNonQueued() {
    Arbiter owner;
    CHECK(makeIdle(owner));
    Lease lease = acquire(owner, Mode::installation);
    CHECK(static_cast<bool>(lease));

    Arbiter contender;
    CHECK(contender.check() == State::unavailable);
    CHECK(contender.error() == Error::lock_busy);
    CHECK(owner.check() == State::installation);
    owner.revoke();
    return true;
}

bool testExpiryDoesNotBecomeIdle() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    Lease lease = acquire(arbiter, Mode::maintenance, 100);
    CHECK(static_cast<bool>(lease));
    sleepMs(200);
    CHECK(!arbiter.renew(lease, 100));
    CHECK(arbiter.check() == State::quarantined);
    CHECK(arbiter.error() == Error::expired);
    CHECK(!arbiter.acceptReconciliation());
    CHECK(arbiter.beginRestoration(lease));
    CHECK(arbiter.finishRestoration(lease, true));
    CHECK(arbiter.check() == State::idle);
    return true;
}

bool testOwnerDeadlineCapsRenewal() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    const std::uint64_t ownerDeadline = monotonicMs() + 500;
    Lease lease = arbiter.acquire(Mode::installation, 5000, ownerDeadline);
    CHECK(static_cast<bool>(lease));
    sleepMs(100);
    CHECK(arbiter.renew(lease, 5000));
    CHECK(waitPast(ownerDeadline + 150));
    CHECK(arbiter.check() == State::quarantined);
    CHECK(arbiter.error() == Error::expired);
    CHECK(!arbiter.renew(lease, 5000));
    return true;
}

bool testRestorationRetainsAndReleasesOwnership() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    Lease lease = acquire(arbiter, Mode::maintenance);
    CHECK(static_cast<bool>(lease));
    CHECK(arbiter.beginRestoration(lease));
    CHECK(arbiter.check() == State::restoring);
    CHECK(!arbiter.finishRestoration(lease, false));
    CHECK(arbiter.check() == State::quarantined);

    Arbiter blocked;
    CHECK(blocked.check() == State::unavailable);
    CHECK(blocked.error() == Error::lock_busy);

    CHECK(arbiter.beginRestoration(lease));
    CHECK(arbiter.finishRestoration(lease, true));
    CHECK(arbiter.check() == State::idle);
    return true;
}

bool testExpiredLeaseCanRestore() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    Lease lease = acquire(arbiter, Mode::installation, 100);
    CHECK(static_cast<bool>(lease));
    sleepMs(200);
    CHECK(arbiter.beginRestoration(lease));
    CHECK(arbiter.check() == State::restoring);
    CHECK(arbiter.finishRestoration(lease, true));
    CHECK(arbiter.check() == State::idle);
    return true;
}

bool testForeignAndDuplicateTokens() {
    Lease foreign;
    {
        Arbiter first;
        CHECK(makeIdle(first));
        foreign = acquire(first, Mode::installation);
        CHECK(static_cast<bool>(foreign));
        CHECK(first.beginRestoration(foreign));
        CHECK(first.finishRestoration(foreign, true));
        CHECK(!first.renew(foreign, 1000));
        CHECK(!first.beginRestoration(foreign));
    }

    Arbiter second;
    CHECK(makeIdle(second));
    Lease current = acquire(second, Mode::maintenance);
    CHECK(static_cast<bool>(current));
    CHECK(!second.renew(foreign, 1000));
    CHECK(!second.beginRestoration(foreign));
    CHECK(second.renew(current, 1000));
    Lease duplicate = current;
    CHECK(second.beginRestoration(duplicate));
    CHECK(second.finishRestoration(duplicate, true));
    CHECK(!second.renew(current, 1000));
    CHECK(!second.finishRestoration(current, true));
    return true;
}

bool testCrashReleasesFlockButNotQuarantine() {
    const pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) {
        Arbiter arbiter;
        if (arbiter.check() != State::quarantined || !arbiter.acceptReconciliation()) _exit(10);
        Lease lease = acquire(arbiter, Mode::installation);
        if (!lease) _exit(11);
        _exit(0);
    }

    int status = 0;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    Arbiter afterCrash;
    CHECK(afterCrash.check() == State::quarantined);
    CHECK(afterCrash.error() == Error::none);
    CHECK(afterCrash.acceptReconciliation());
    afterCrash.revoke();
    return true;
}

bool testUnsafeDirectoryModeIsRefused() {
    struct stat original {};
    CHECK(lstat(kDirectory, &original) == 0 && safeDirectory(original));
    CHECK(chmod(kDirectory, 0755) == 0);
    Arbiter arbiter;
    CHECK(arbiter.check() == State::unavailable);
    CHECK(arbiter.error() == Error::identity);
    struct stat unchanged {};
    CHECK(lstat(kDirectory, &unchanged) == 0);
    CHECK(sameInode(original, unchanged));
    CHECK((unchanged.st_mode & 07777U) == 0755U);
    CHECK(chmod(kDirectory, 0700) == 0);
    return true;
}

bool testUnsafeSymlinkIsRefused() {
    struct stat original {};
    CHECK(lstat(kLock, &original) == 0 && safeLock(original));
    char backup[128] {};
    std::snprintf(backup, sizeof(backup), "%s.restore.%ld", kLock, static_cast<long>(getpid()));
    CHECK(access(backup, F_OK) != 0 && errno == ENOENT);
    CHECK(rename(kLock, backup) == 0);
    CHECK(symlink("/dev/null", kLock) == 0);

    bool result = false;
    {
        Arbiter arbiter;
        result = arbiter.check() == State::unavailable && arbiter.error() == Error::identity;
        struct stat unchanged {};
        result = result && lstat(kLock, &unchanged) == 0 && S_ISLNK(unchanged.st_mode);
    }
    CHECK(unlink(kLock) == 0);
    CHECK(rename(backup, kLock) == 0);
    CHECK(result);
    struct stat restored {};
    CHECK(lstat(kLock, &restored) == 0 && sameInode(original, restored) && safeLock(restored));
    return true;
}

bool testUnsafeHardlinkIsRefused() {
    char sibling[128] {};
    std::snprintf(sibling, sizeof(sibling), "%s.extra", kLock);
    CHECK(access(sibling, F_OK) != 0 && errno == ENOENT);
    CHECK(link(kLock, sibling) == 0);

    bool result = false;
    {
        Arbiter arbiter;
        struct stat unchanged {};
        result = arbiter.check() == State::unavailable && arbiter.error() == Error::identity &&
                 lstat(kLock, &unchanged) == 0 && unchanged.st_nlink == 2;
    }
    CHECK(unlink(sibling) == 0);
    CHECK(result);
    struct stat restored {};
    CHECK(lstat(kLock, &restored) == 0 && safeLock(restored));
    return true;
}

bool testIdentityDriftCannotRecoverInPlace() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    CHECK(chmod(kLock, 0644) == 0);
    CHECK(arbiter.check() == State::unavailable);
    CHECK(arbiter.error() == Error::identity);
    CHECK(chmod(kLock, 0600) == 0);
    CHECK(!arbiter.acceptReconciliation());
    CHECK(arbiter.check() == State::unavailable);
    return true;
}

bool testInvalidBoundsAndConcurrentModes() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    CHECK(!arbiter.acquire(Mode::installation, 0, monotonicMs() + 3000));
    CHECK(!arbiter.acquire(Mode::installation, 5001, monotonicMs() + 3000));
    CHECK(!arbiter.acquire(Mode::installation, 100, 0));
    CHECK(!arbiter.acquire(static_cast<Mode>(99), 100, monotonicMs() + 3000));
    CHECK(arbiter.check() == State::idle);
    std::atomic<int> ready{0};
    std::atomic<bool> start{false};
    Lease installation, maintenance;
    auto contender = [&](Mode mode, Lease& lease) {
        ready.fetch_add(1);
        while (!start.load()) std::this_thread::yield();
        lease = acquire(arbiter, mode);
    };
    std::thread first(contender, Mode::installation, std::ref(installation));
    std::thread second(contender, Mode::maintenance, std::ref(maintenance));
    while (ready.load() != 2) std::this_thread::yield();
    start.store(true);
    first.join(); second.join();
    CHECK(static_cast<bool>(installation) != static_cast<bool>(maintenance));
    CHECK(!arbiter.acceptReconciliation());
    Lease winner = installation ? installation : maintenance;
    CHECK(arbiter.beginRestoration(winner));
    CHECK(arbiter.finishRestoration(winner, true));
    return true;
}

bool testForkedObjectIsRejected() {
    Arbiter arbiter;
    CHECK(makeIdle(arbiter));
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) {
        const bool rejected = arbiter.check() == State::unavailable && !arbiter.acceptReconciliation();
        _exit(rejected ? 0 : 12);
    }
    int status = 0;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    CHECK(arbiter.check() == State::idle);
    return true;
}

bool environmentAllowsPrivilegedFixture() {
    const char* actions = std::getenv("GITHUB_ACTIONS");
    const char* runner = std::getenv("RUNNER_ENVIRONMENT");
    return actions != nullptr && std::strcmp(actions, "true") == 0 && runner != nullptr &&
           std::strcmp(runner, "github-hosted") == 0 && geteuid() == 0;
}

}  // namespace

int main() {
    if (!environmentAllowsPrivilegedFixture()) return 2;

    Fixture fixture;
    if (!fixture.prepare()) return 1;

    if (!testStartupQuarantine()) return 1;
    if (!testAcquisitionOrder(Mode::installation, Mode::maintenance)) return 1;
    if (!testAcquisitionOrder(Mode::maintenance, Mode::installation)) return 1;
    if (!testSecondObjectIsNonQueued()) return 1;
    if (!testExpiryDoesNotBecomeIdle()) return 1;
    if (!testOwnerDeadlineCapsRenewal()) return 1;
    if (!testRestorationRetainsAndReleasesOwnership()) return 1;
    if (!testExpiredLeaseCanRestore()) return 1;
    if (!testForeignAndDuplicateTokens()) return 1;
    if (!testCrashReleasesFlockButNotQuarantine()) return 1;
    if (!testUnsafeDirectoryModeIsRefused()) return 1;
    if (!testUnsafeSymlinkIsRefused()) return 1;
    if (!testUnsafeHardlinkIsRefused()) return 1;
    if (!testIdentityDriftCannotRecoverInPlace()) return 1;
    if (!testInvalidBoundsAndConcurrentModes()) return 1;
    if (!testForkedObjectIsRejected()) return 1;
    return fixture.cleanup() ? 0 : 1;
}
