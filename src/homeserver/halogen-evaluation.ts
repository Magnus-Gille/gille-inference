/** First, synthetic-only Halogen evaluation. Actual commands live behind injected operations. */
import { z } from 'zod';
import { runMaintenanceWindowCommand, type MaintenanceWindowClientDependencies, type MaintenanceWindowOpeningEvidence } from './maintenance-window-client.js';
import { parseGatewayBaseUrl } from './halogen-gateway-url.js';

export interface HalogenEvaluationOperations {
  /** Read-only identity, artifacts, absent-unit and protected-service checks. */
  preflight(): Promise<void>;
  stopPriorExperiment(): Promise<void>;
  quiesceSwap(): Promise<void>;
  assertHeadroom(): Promise<void>;
  startCandidate(): Promise<void>;
  verifyContainment(): Promise<void>;
  waitForReady(signal: AbortSignal): Promise<void>;
  compatibility(signal: AbortSignal): Promise<unknown>;
  /** Must establish no surviving candidate processes; never merely send a signal. */
  ensureCandidateStopped(): Promise<void>;
  assertSafeToRestore(): Promise<void>;
  restorePriorExperiment(): Promise<void>;
  restoreSwap(residents: MaintenanceWindowOpeningEvidence['runningModels']): Promise<void>;
  verifyRestoration(): Promise<void>;
}

export interface HalogenEvaluationDependencies {
  operations: HalogenEvaluationOperations;
  apiKey: string;
  expectedResidentModels: readonly string[];
  approvedExpiresAt: string;
  /** Approved local gateway address (#323). Never defaults: the caller binds it. */
  gatewayBaseUrl: string;
  /** Override for this box's interface addresses (tests only). */
  localAddresses?: readonly string[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
  runWindow?: typeof runMaintenanceWindowCommand;
}

/** Prove the approved gateway answers as the maintenance endpoint before any mutation. */
async function verifyGatewayIdle(
  fetchImpl: typeof fetch,
  gatewayBaseUrl: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetchImpl(`${gatewayBaseUrl}/admin/maintenance/window`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `gateway unreachable at approved address ${gatewayBaseUrl}: ${(error as Error).message}`,
    );
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(`gateway refused the check at ${gatewayBaseUrl} (HTTP ${response.status})`);
  }
  const body = (await response.json().catch(() => null)) as { active?: unknown } | null;
  if (typeof body !== 'object' || body === null || typeof body.active !== 'boolean') {
    throw new Error(`gateway gave a malformed window status at ${gatewayBaseUrl}`);
  }
  if (body.active) throw new Error(`a maintenance window is already active at ${gatewayBaseUrl}`);
}

/** Ordering is deliberate: verified candidate shutdown precedes reloading any resident model. */
export async function runHalogenCompatibilityEvaluation(deps: HalogenEvaluationDependencies): Promise<unknown> {
  if (deps.expectedResidentModels.length > 1 || deps.expectedResidentModels.some(m => !/^[a-zA-Z0-9._-]{1,128}$/.test(m))) throw new Error('invalid approved resident set');
  const approvedExpiry = Date.parse(deps.approvedExpiresAt);
  if (!Number.isFinite(approvedExpiry)) throw new Error('invalid approved expiry');
  const gatewayBaseUrl = parseGatewayBaseUrl(deps.gatewayBaseUrl, deps.localAddresses);
  await verifyGatewayIdle(deps.fetch ?? fetch, gatewayBaseUrl, deps.apiKey, deps.signal);
  const op = deps.operations;
  await op.preflight();
  let canRelease = true;
  let result: unknown;
  const windowDeps: MaintenanceWindowClientDependencies = {
    fetch: deps.fetch ?? fetch, apiKey: deps.apiKey, signal: deps.signal,
    canReleaseWindow: () => canRelease,
    runChild: async (_command, opened, windowSignal) => {
      if (Date.parse(opened.expiresAt) > approvedExpiry) throw new Error('maintenance window exceeds approved expiry');
      const residents = opened.runningModels;
      if (residents.length > 1 || residents.some(r => r.state !== 'ready')) {
        throw new Error('ambiguous prior swap residency; no runtime mutation attempted');
      }
      if (JSON.stringify(residents.map(r => r.model)) !== JSON.stringify(deps.expectedResidentModels)) throw new Error('resident set differs from approved plan');
      let priorTouched = false;
      let swapTouched = false;
      let candidateTouched = false;
      let workError: unknown;
      const cleanupErrors: unknown[] = [];
      const signal = deps.signal ? AbortSignal.any([windowSignal, deps.signal]) : windowSignal;
      try {
        signal.throwIfAborted();
        // Mark before each operation: a failed response does not prove no mutation happened.
        canRelease = false;
        priorTouched = true;
        await op.stopPriorExperiment();
        signal.throwIfAborted();
        swapTouched = true;
        await op.quiesceSwap();
        await op.assertHeadroom();
        signal.throwIfAborted();
        candidateTouched = true;
        await op.startCandidate();
        await op.verifyContainment();
        await op.waitForReady(signal);
        result = await op.compatibility(signal);
        z.object({ schemaVersion: z.literal(1), gate: z.literal('synthetic-compatibility-only'),
          pass: z.literal(true), rows: z.array(z.object({ pass: z.literal(true) })).length(5),
        }).parse(result);
        signal.throwIfAborted();
      } catch (error) {
        workError = error;
      } finally {
        let candidateStopped = !candidateTouched;
        if (candidateTouched) {
          try { await op.ensureCandidateStopped(); candidateStopped = true; }
          catch (error) { cleanupErrors.push(error); }
        }
        // Never reload a model alongside a candidate whose shutdown is unverified.
        let safeToRestore = candidateStopped;
        if (safeToRestore) {
          try { await op.assertSafeToRestore(); }
          catch (error) { cleanupErrors.push(error); safeToRestore = false; }
        }
        if (safeToRestore) {
          if (priorTouched) {
            try { await op.restorePriorExperiment(); }
            catch (error) { cleanupErrors.push(error); }
          }
          if (swapTouched && cleanupErrors.length === 0) {
            try { await op.restoreSwap(residents); }
            catch (error) { cleanupErrors.push(error); }
          }
          try { await op.verifyRestoration(); }
          catch (error) { cleanupErrors.push(error); }
          canRelease = cleanupErrors.length === 0;
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(workError === undefined ? cleanupErrors : [workError, ...cleanupErrors],
          'Halogen cleanup/restoration could not be verified; retain exclusion and stop the envelope');
      }
      if (workError !== undefined) throw workError;
      return 0;
    },
  };
  await (deps.runWindow ?? runMaintenanceWindowCommand)({
    baseUrl: gatewayBaseUrl, ttlSeconds: 3600, drainTimeoutSeconds: 60,
    abortBeforeExpirySeconds: 600, command: ['halogen-synthetic-compatibility'],
  }, windowDeps);
  return result;
}
