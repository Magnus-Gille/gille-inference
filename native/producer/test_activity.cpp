#include "activity.h"

#include <cassert>
#include <cstdint>
#include <atomic>
#include <thread>
#include <vector>

int main() {
    using namespace gille::producer;

    Activity activity;
    Snapshot initial = activity.snapshot();
    assert(initial.known && initial.active == 0 && initial.queued == 0 &&
           initial.loading == 0 && initial.workStarted == 0);
    Token inert;
    assert(activity.transition(inert, static_cast<Stage>(255)));
    assert(activity.finish(inert));
    assert(activity.snapshot().known);

    Token queued = activity.begin(Stage::queued);
    assert(queued && activity.snapshot().queued == 1);
    assert(activity.transition(queued, Stage::active));
    assert(activity.snapshot().active == 1 && activity.snapshot().queued == 0);
    assert(activity.finish(queued));
    Snapshot afterFinish = activity.snapshot();
    assert(afterFinish.known && afterFinish.active == 0 && afterFinish.workStarted == 1);

    assert(!activity.finish(queued));
    assert(!activity.snapshot().known);

    Activity staleTransition;
    Token stale = staleTransition.begin(Stage::queued);
    assert(staleTransition.finish(stale));
    assert(!staleTransition.transition(stale, Stage::active));
    assert(!staleTransition.snapshot().known);

    Activity invalidStage;
    Token active = invalidStage.begin(Stage::active);
    assert(active);
    assert(!invalidStage.transition(active, static_cast<Stage>(255)));
    assert(!invalidStage.snapshot().known);

    Activity invalidBegin;
    assert(!invalidBegin.begin(static_cast<Stage>(255)));
    assert(!invalidBegin.snapshot().known);

    Activity foreignA;
    Activity foreignB;
    Token foreignToken = foreignA.begin(Stage::loading);
    Token sameNumber = foreignB.begin(Stage::loading);
    assert(foreignToken.value() == sameNumber.value());
    assert(!foreignB.finish(foreignToken));
    assert(!foreignB.snapshot().known);

    Activity invalidated;
    Token outstanding = invalidated.begin(Stage::queued);
    invalidated.invalidate();
    assert(!invalidated.snapshot().known);
    assert(!invalidated.transition(outstanding, Stage::active));
    assert(!invalidated.finish(outstanding));
    assert(!invalidated.begin(Stage::queued));
    assert(!invalidated.snapshot().known);

    ActivityTestAccess::setLimits(activity, 1, 2);
    (void)activity;  // the already-invalid instance remains permanently invalid.
    Activity capped;
    ActivityTestAccess::setLimits(capped, 1, 2);
    Token first = capped.begin(Stage::active);
    assert(first);
    assert(!capped.begin(Stage::queued));
    assert(!capped.snapshot().known);

    Activity slotReuse;
    ActivityTestAccess::setLimits(slotReuse, 1, 3);
    Token oldToken = slotReuse.begin(Stage::active);
    assert(slotReuse.finish(oldToken));
    Token newToken = slotReuse.begin(Stage::active);
    assert(newToken && oldToken.value() != newToken.value());
    assert(!slotReuse.finish(oldToken));
    assert(!slotReuse.snapshot().known);

    Activity overflow;
    ActivityTestAccess::setLimits(overflow, 2, 2);
    Token firstFinished = overflow.begin(Stage::queued);
    assert(firstFinished && overflow.finish(firstFinished));
    Token secondFinished = overflow.begin(Stage::queued);
    assert(secondFinished && overflow.finish(secondFinished));
    assert(overflow.snapshot().known && overflow.snapshot().workStarted == 2);
    assert(!overflow.begin(Stage::queued));
    assert(!overflow.snapshot().known);

    Activity concurrent;
    constexpr int threadCount = 8;
    constexpr int startsPerThread = 100;
    std::atomic<int> ready{0};
    std::atomic<bool> go{false};
    std::atomic<bool> done{false};
    std::atomic<bool> readerFailed{false};
    std::atomic<bool> observedConcurrentWork{false};
    std::vector<std::thread> threads;
    threads.reserve(threadCount);
    for (int i = 0; i < threadCount; ++i) {
        threads.emplace_back([&concurrent, &ready, &go, &observedConcurrentWork]() {
            ready.fetch_add(1, std::memory_order_release);
            while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
            for (int j = 0; j < startsPerThread; ++j) {
                Token token = concurrent.begin(Stage::queued);
                assert(token);
                if (j == 0) while (!observedConcurrentWork.load(std::memory_order_acquire))
                    std::this_thread::yield();
                assert(concurrent.transition(token, Stage::loading));
                assert(concurrent.finish(token));
            }
        });
    }
    std::thread reader([&concurrent, &ready, &go, &done, &readerFailed, &observedConcurrentWork]() {
        ready.fetch_add(1, std::memory_order_release);
        while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
        while (!done.load(std::memory_order_acquire)) {
            Snapshot snapshot = concurrent.snapshot();
            const std::uint64_t outstanding = snapshot.active + snapshot.queued + snapshot.loading;
            if (outstanding == threadCount) observedConcurrentWork.store(true, std::memory_order_release);
            if (!snapshot.known || outstanding > threadCount ||
                snapshot.workStarted < outstanding) {
                readerFailed.store(true, std::memory_order_release);
            }
        }
    });
    while (ready.load(std::memory_order_acquire) != threadCount + 1) std::this_thread::yield();
    go.store(true, std::memory_order_release);
    for (std::thread& thread : threads) thread.join();
    done.store(true, std::memory_order_release);
    reader.join();
    assert(observedConcurrentWork.load(std::memory_order_acquire));
    assert(!readerFailed.load(std::memory_order_acquire));
    Snapshot concurrentSnapshot = concurrent.snapshot();
    assert(concurrentSnapshot.known && concurrentSnapshot.active == 0 &&
           concurrentSnapshot.queued == 0 && concurrentSnapshot.loading == 0 &&
           concurrentSnapshot.workStarted == threadCount * startsPerThread);

    return 0;
}

void gille::producer::ActivityTestAccess::setLimits(Activity& activity,
                                                      std::size_t maxTrackedWork,
                                                      std::uint64_t maxSequence) {
    std::lock_guard<std::mutex> lock(activity.mutex_);
    activity.maxTrackedWork_ = maxTrackedWork;
    activity.maxSequence_ = maxSequence;
}
