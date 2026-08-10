/**
 * Bounded, content-blind model lifecycle observation.
 *
 * The observer only reads the backend's sanitized running snapshot. It has no
 * model-control path and all polling/persistence failures are contained so a
 * backend or SQLite problem cannot affect request handling.
 */

import { getRunningSnapshot } from "./model-admin.js";
import {
  appendModelLifecycleEvents,
  reconcileModelLifecycleSnapshots,
  type ModelLifecycleEvent,
  type SanitizedModelSnapshotEntry,
} from "./model-lifecycle.js";

/** Conservative enough to keep this diagnostic path out of the request hot path. */
export const MODEL_LIFECYCLE_OBSERVER_INTERVAL_MS = 60_000;

type LifecycleTimer = ReturnType<typeof setInterval>;

export interface ModelLifecycleObserverDependencies {
  getRunningSnapshot: () => Promise<readonly SanitizedModelSnapshotEntry[]>;
  appendModelLifecycleEvents: (events: readonly ModelLifecycleEvent[]) => void;
  now: () => number;
  setInterval: (callback: () => void, delayMs: number) => LifecycleTimer;
  clearInterval: (timer: LifecycleTimer) => void;
  reportError: (error: unknown) => void;
}

export interface ModelLifecycleObserverHandle {
  stop: () => void;
}

const defaultDependencies: ModelLifecycleObserverDependencies = {
  getRunningSnapshot,
  appendModelLifecycleEvents,
  now: () => Date.now(),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer),
  reportError: (error) => console.error("[model-lifecycle] observer failed (ignored):", error),
};

/**
 * Start one immediate observation followed by an unref'd periodic observation.
 * The dependency seam keeps timer and failure behavior deterministic in tests.
 */
export function startModelLifecycleObserver(
  overrides: Partial<ModelLifecycleObserverDependencies> = {},
): ModelLifecycleObserverHandle {
  const dependencies = { ...defaultDependencies, ...overrides };
  let previousSnapshot: SanitizedModelSnapshotEntry[] = [];
  let inFlight = false;
  let stopped = false;

  const reportFailure = (error: unknown): void => {
    try {
      dependencies.reportError(error);
    } catch {
      // Diagnostics must never become an uncaught exception of the gateway.
    }
  };

  const observeOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const currentSnapshot = await dependencies.getRunningSnapshot();
      if (stopped) return;

      const transitions = reconcileModelLifecycleSnapshots(previousSnapshot, currentSnapshot);
      if (transitions.length > 0) {
        const ts = new Date(dependencies.now()).toISOString();
        dependencies.appendModelLifecycleEvents(
          transitions.map((transition): ModelLifecycleEvent => ({
            ts,
            model: transition.model,
            event: transition.event,
            state: transition.state,
            ttlSeconds: transition.ttlSeconds,
            cause: transition.cause,
          })),
        );
      }

      // Reconciliation has validated the closed snapshot contract. Keep an
      // independent copy so no backend-owned array can become observer state.
      previousSnapshot = currentSnapshot.map(({ model, state, ttlSeconds }) => ({
        model,
        state,
        ttlSeconds,
      }));
    } catch (error) {
      reportFailure(error);
    } finally {
      inFlight = false;
    }
  };

  const timer = dependencies.setInterval(() => {
    void observeOnce();
  }, MODEL_LIFECYCLE_OBSERVER_INTERVAL_MS);
  timer.unref?.();
  void observeOnce();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      dependencies.clearInterval(timer);
    },
  };
}
