#ifndef GILLE_HOST_ARBITER_H
#define GILLE_HOST_ARBITER_H
#include <array>
#include <cstdint>
#include <mutex>
#include <sys/stat.h>

namespace gille::launcher {
enum class Mode { installation, maintenance };
enum class State { unavailable, quarantined, idle, installation, maintenance, restoring };
enum class Error { none, identity, lock_busy, entropy, clock, expired, sequence, restoration, revoked };

class Arbiter;
class Lease final {
public:
    Lease() = default;
    explicit operator bool() const { return sequence_ != 0; }
private:
    friend class Arbiter;
    std::array<unsigned char, 16> instance_{};
    std::uint64_t sequence_ = 0;
};

// Internal fixed-launcher primitive; NOT an RPC or admission API. Linux/root only.
// The broker alone opens this object and must outlive every Lease. No caller may
// receive the lock descriptor. The broker must not fork after construction;
// launch workloads through the service manager. A forked child inherits the flock
// until its descriptor is closed, even though this API rejects its operations.
// Production integration must authenticate callers,
// verify reconciliation/restoration and independently enforce execution expiry.
class Arbiter final {
public:
    Arbiter();
    ~Arbiter();
    Arbiter(const Arbiter&) = delete;
    Arbiter& operator=(const Arbiter&) = delete;
    State check();
    Error error();
    // Trusted host reconciliation calls this only after proving no outstanding
    // work, restored maintenance/fence/GPU state, and protected-state restoration.
    // Never expose this transition directly to an IPC client or heartbeat.
    bool acceptReconciliation();
    // Owner heartbeat TTL is 1..5000ms, capped by an immutable monotonic owner
    // deadline. It is NOT evidence freshness or permission to execute a workload.
    Lease acquire(Mode mode, std::uint32_t ttlMs, std::uint64_t ownerDeadlineMs);
    bool renew(const Lease& lease, std::uint32_t ttlMs);
    bool beginRestoration(const Lease& lease);
    // Called only after independently verified restoration; false quarantines.
    bool finishRestoration(const Lease& lease, bool verified);
    void revoke();
private:
    bool identityMatches() const;
    bool matches(const Lease& lease) const;
    bool refresh(std::uint64_t& now);
    void quarantine(Error reason);
    std::mutex mutex_;
    int directory_ = -1, lock_ = -1;
    pid_t process_ = 0;
    struct stat parent_{}, inode_{};
    std::array<unsigned char, 16> instance_{};
    State state_ = State::unavailable;
    Error error_ = Error::none;
    std::uint64_t lastClock_ = 0, sequence_ = 0, activeSequence_ = 0;
    std::uint64_t expires_ = 0, ownerDeadline_ = 0;
};
}
#endif
