import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HALOGEN_RUN_IDENTITY_COLLISION = 'run-identity-collision' as const;

export interface HalogenRunReceiptCommon {
  schemaVersion: 1;
  gate: 'synthetic-compatibility-only';
  planSha256: string;
  runnerSha256: string;
  runnerCommit: string;
  profileSha256: string;
}

export type HalogenRunReservation =
  | { status: 'reserved'; claimPath: string; receiptPath: string }
  | {
      status: 'refused';
      attemptedRun: string;
      collision: 'claim' | 'receipt';
      receiptPath: string;
      reason: typeof HALOGEN_RUN_IDENTITY_COLLISION;
    };

interface ReservationOptions {
  runDirectory: string;
  runName: string;
  common: HalogenRunReceiptCommon;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Reserve one exact run identity before any host operation is invoked.
 *
 * A refusal receipt uses a hash-bound, deterministic attempt name and O_EXCL,
 * so an old run receipt can never be reported as the current attempt's result.
 * The allocator is deliberately limited to the caller-provided tracked run
 * directory; it does not discover or create another staging location.
 */
export async function reserveHalogenRun(options: ReservationOptions): Promise<HalogenRunReservation> {
  const claimPath = join(options.runDirectory, `${options.runName}.claim`);
  const receiptPath = join(options.runDirectory, `${options.runName}.json`);
  const targets: Array<{ kind: 'receipt' | 'claim'; path: string }> = [
    { kind: 'receipt', path: receiptPath },
    { kind: 'claim', path: claimPath },
  ];

  const refuse = async (collision: 'claim' | 'receipt'): Promise<HalogenRunReservation> => {
    const attemptPrefix = `${options.runName}.attempt-${options.common.planSha256.slice(0, 16)}`;
    for (let sequence = 1; sequence <= 10_000; sequence++) {
      const suffix = sequence === 1 ? '' : `-${String(sequence).padStart(2, '0')}`;
      const attemptReceiptPath = join(options.runDirectory, `${attemptPrefix}${suffix}.json`);
      const refusal = {
        ...options.common,
        pass: false,
        status: 'refused' as const,
        attemptedRun: options.runName,
        reason: HALOGEN_RUN_IDENTITY_COLLISION,
        collision,
        receipt: attemptReceiptPath,
      };
      try {
        await writeFile(attemptReceiptPath, `${JSON.stringify(refusal)}\n`, { flag: 'wx', mode: 0o600 });
        return {
          status: 'refused', attemptedRun: options.runName, collision,
          receiptPath: attemptReceiptPath, reason: HALOGEN_RUN_IDENTITY_COLLISION,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('unable to allocate a private collision diagnostic receipt');
  };

  for (const target of targets) {
    if (await pathExists(target.path)) return refuse(target.kind);
  }

  try {
    await writeFile(claimPath, `${JSON.stringify(options.common)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return refuse('claim');
    throw error;
  }
  return { status: 'reserved', claimPath, receiptPath };
}

export async function writeHalogenRunReceipt(path: string, receipt: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
}
