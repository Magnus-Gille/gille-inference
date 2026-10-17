#ifndef GILLE_PRODUCER_ACTIVITY_H
#define GILLE_PRODUCER_ACTIVITY_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <mutex>

namespace gille::producer {

enum class Stage : std::uint8_t {
    queued,
    active,
    loading,
};

struct Snapshot {
    // Unknown snapshots must serialize nullable counts, never idle zeros.
    bool known = false;
    std::uint64_t active = 0;
    std::uint64_t queued = 0;
    std::uint64_t loading = 0;
    std::uint64_t workStarted = 0;
};

class Activity;

// A token is deliberately bound to the Activity which created it.  Copies are
// harmless, but using a token with another Activity is a telemetry fault. The
// Activity must outlive every token; production is expected to use one
// long-lived tracker per producer.
class Token final {
public:
    Token() = default;
    Token(const Token&) = default;
    Token& operator=(const Token&) = default;

    std::uint64_t value() const { return value_; }
    explicit operator bool() const { return value_ != 0; }

private:
    friend class Activity;
    Activity* owner_ = nullptr;
    std::uint64_t value_ = 0;
    Token(Activity* owner, std::uint64_t value) : owner_(owner), value_(value) {}
};

// Content-blind, bounded producer activity accounting.  It has no production
// configuration surface: the fixed limits are part of this primitive's ABI.
class Activity final {
public:
    Activity() = default;
    Activity(const Activity&) = delete;
    Activity& operator=(const Activity&) = delete;

    Token begin(Stage stage);
    bool transition(const Token& token, Stage stage);
    bool finish(const Token& token);
    void invalidate();
    Snapshot snapshot() const;

private:
    friend struct ActivityTestAccess;

    static constexpr std::size_t kMaxTrackedWork = 4096;
    static constexpr std::uint64_t kMaxSequence = 9007199254740991ULL;

    struct Record {
        std::uint64_t token = 0;
        Stage stage = Stage::queued;
        bool used = false;
    };

    static bool validStage(Stage stage);
    void latchFaultLocked();
    Record* findLocked(const Token& token);

    mutable std::mutex mutex_;
    std::array<Record, kMaxTrackedWork> records_{};
    std::size_t tracked_ = 0;
    std::uint64_t active_ = 0;
    std::uint64_t queued_ = 0;
    std::uint64_t loading_ = 0;
    std::uint64_t workStarted_ = 0;
    bool known_ = true;
    std::size_t maxTrackedWork_ = kMaxTrackedWork;
    std::uint64_t maxSequence_ = kMaxSequence;
};

// Tests may lower limits on an instance without exposing runtime configuration.
// This friend is intentionally defined only by the test translation unit.
struct ActivityTestAccess {
    static void setLimits(Activity& activity, std::size_t maxTrackedWork,
                          std::uint64_t maxSequence);
};

}  // namespace gille::producer

#endif
