#include "activity.h"

namespace gille::producer {

namespace {

void increment(std::uint64_t& counter) {
    ++counter;
}

void decrement(std::uint64_t& counter) {
    --counter;
}

}  // namespace

bool Activity::validStage(Stage stage) {
    return stage == Stage::queued || stage == Stage::active || stage == Stage::loading;
}

void Activity::latchFaultLocked() {
    if (!known_) return;
    known_ = false;
    for (Record& record : records_) {
        record.used = false;
        record.token = 0;
    }
    tracked_ = 0;
    active_ = 0;
    queued_ = 0;
    loading_ = 0;
}

Activity::Record* Activity::findLocked(const Token& token) {
    if (token.owner_ != this || token.value_ == 0) return nullptr;
    for (Record& record : records_) {
        if (record.used && record.token == token.value_) return &record;
    }
    return nullptr;
}

Token Activity::begin(Stage stage) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!known_ || !validStage(stage) || tracked_ >= maxTrackedWork_ ||
        workStarted_ >= maxSequence_) {
        latchFaultLocked();
        return Token{};
    }

    ++workStarted_;
    for (Record& record : records_) {
        if (!record.used) {
            record.used = true;
            record.token = workStarted_;
            record.stage = stage;
            ++tracked_;
            if (stage == Stage::active) increment(active_);
            else if (stage == Stage::queued) increment(queued_);
            else increment(loading_);
            return Token(this, workStarted_);
        }
    }

    // The tracked count and fixed array must agree.  Preserve the closed state
    // if an internal invariant is ever violated.
    latchFaultLocked();
    return Token{};
}

bool Activity::transition(const Token& token, Stage stage) {
    if (token.value_ == 0) return true;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!known_ || !validStage(stage)) {
        latchFaultLocked();
        return false;
    }
    Record* record = findLocked(token);
    if (record == nullptr) {
        latchFaultLocked();
        return false;
    }
    if (record->stage == stage) return true;
    if (record->stage == Stage::active) decrement(active_);
    else if (record->stage == Stage::queued) decrement(queued_);
    else decrement(loading_);
    if (stage == Stage::active) increment(active_);
    else if (stage == Stage::queued) increment(queued_);
    else increment(loading_);
    record->stage = stage;
    return true;
}

bool Activity::finish(const Token& token) {
    if (token.value_ == 0) return true;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!known_) return false;
    Record* record = findLocked(token);
    if (record == nullptr) {
        latchFaultLocked();
        return false;
    }
    if (record->stage == Stage::active) decrement(active_);
    else if (record->stage == Stage::queued) decrement(queued_);
    else decrement(loading_);
    record->used = false;
    record->token = 0;
    --tracked_;
    return true;
}

void Activity::invalidate() {
    std::lock_guard<std::mutex> lock(mutex_);
    latchFaultLocked();
}

Snapshot Activity::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!known_) return Snapshot{false, 0, 0, 0, 0};
    return Snapshot{true, active_, queued_, loading_, workStarted_};
}

}  // namespace gille::producer
