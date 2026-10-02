import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HALOGEN_RUN_IDENTITY_COLLISION,
  reserveHalogenRun,
  writeHalogenRunReceipt,
  type HalogenRunReceiptCommon,
} from '../src/homeserver/halogen-run-receipt.js';

const common: HalogenRunReceiptCommon = {
  schemaVersion: 1,
  gate: 'synthetic-compatibility-only',
  planSha256: 'a'.repeat(64),
  runnerSha256: 'b'.repeat(64),
  runnerCommit: 'c'.repeat(40),
  profileSha256: 'd'.repeat(64),
};
const runName = 'gille-317-halogen-01';
const directories: string[] = [];

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'halogen-run-receipts-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Halogen run identity receipts', () => {
  it('refuses a stale receipt before any synthetic service callback and records the current attempt', async () => {
    const directory = await fixture();
    const staleReceipt = join(directory, `${runName}.json`);
    await writeFile(staleReceipt, JSON.stringify({ pass: false, error: 'old attempt' }), { mode: 0o600 });
    let serviceCalls = 0;

    const reservation = await reserveHalogenRun({ runDirectory: directory, runName, common });

    expect(reservation.status).toBe('refused');
    if (reservation.status === 'reserved') serviceCalls++;
    expect(serviceCalls).toBe(0);
    if (reservation.status !== 'refused') return;
    expect(reservation.reason).toBe(HALOGEN_RUN_IDENTITY_COLLISION);
    expect(reservation.collision).toBe('receipt');
    expect(reservation.receiptPath).not.toBe(staleReceipt);
    const refusal = JSON.parse(await readFile(reservation.receiptPath, 'utf8')) as Record<string, unknown>;
    expect(refusal).toMatchObject({
      pass: false,
      status: 'refused',
      attemptedRun: runName,
      reason: HALOGEN_RUN_IDENTITY_COLLISION,
      receipt: reservation.receiptPath,
    });
    // A refusal is returned before the caller constructs or invokes host operations.
  });

  it('refuses a claimed identity without exposing arbitrary collision details', async () => {
    const directory = await fixture();
    await writeFile(join(directory, `${runName}.claim`), 'prior claim', { mode: 0o600 });

    const reservation = await reserveHalogenRun({ runDirectory: directory, runName, common });

    expect(reservation).toMatchObject({
      status: 'refused',
      attemptedRun: runName,
      collision: 'claim',
      reason: HALOGEN_RUN_IDENTITY_COLLISION,
    });
    if (reservation.status === 'refused') {
      const text = await readFile(reservation.receiptPath, 'utf8');
      expect(text).not.toContain('prior claim');
      expect(text).not.toContain('Error:');
    }
  });

  it('reserves a fresh identity, then records distinct success and failure receipts', async () => {
    const successDirectory = await fixture();
    const success = await reserveHalogenRun({ runDirectory: successDirectory, runName, common });
    expect(success.status).toBe('reserved');
    if (success.status !== 'reserved') return;
    await writeHalogenRunReceipt(success.receiptPath, { ...common, pass: true, result: { rows: 5 } });
    expect(JSON.parse(await readFile(success.receiptPath, 'utf8'))).toMatchObject({ pass: true, result: { rows: 5 } });

    const failureDirectory = await fixture();
    const failure = await reserveHalogenRun({ runDirectory: failureDirectory, runName, common: { ...common, planSha256: 'e'.repeat(64) } });
    expect(failure.status).toBe('reserved');
    if (failure.status !== 'reserved') return;
    await writeHalogenRunReceipt(failure.receiptPath, { ...common, pass: false, errorClass: 'Error', diagnostics: [{ name: 'Error', message: 'synthetic failure' }] });
    expect(JSON.parse(await readFile(failure.receiptPath, 'utf8'))).toMatchObject({ pass: false, errorClass: 'Error' });
  });

  it('allocates deterministic private refusal receipts for repeated attempts without reusing an old receipt', async () => {
    const directory = await fixture();
    await writeFile(join(directory, `${runName}.json`), 'old receipt', { mode: 0o600 });

    const first = await reserveHalogenRun({ runDirectory: directory, runName, common });
    const second = await reserveHalogenRun({ runDirectory: directory, runName, common });

    expect(first.status).toBe('refused');
    expect(second.status).toBe('refused');
    if (first.status !== 'refused' || second.status !== 'refused') return;
    expect(first.receiptPath).toMatch(/\.attempt-aaaaaaaaaaaaaaaa\.json$/);
    expect(second.receiptPath).toMatch(/\.attempt-aaaaaaaaaaaaaaaa-02\.json$/);
    expect(first.receiptPath).not.toBe(second.receiptPath);
    expect(await readFile(join(directory, `${runName}.json`), 'utf8')).toBe('old receipt');
  });

  it('allows only one concurrent reservation and gives the loser a fresh private refusal receipt', async () => {
    const directory = await fixture();

    const reservations = await Promise.all([
      reserveHalogenRun({ runDirectory: directory, runName, common }),
      reserveHalogenRun({ runDirectory: directory, runName, common }),
    ]);

    const winners = reservations.filter(reservation => reservation.status === 'reserved');
    const refusals = reservations.filter(reservation => reservation.status === 'refused');
    expect(winners).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    const winner = winners[0]!;
    const refusal = refusals[0]!;
    if (winner.status !== 'reserved' || refusal.status !== 'refused') return;

    expect(refusal).toMatchObject({
      attemptedRun: runName,
      collision: 'claim',
      reason: HALOGEN_RUN_IDENTITY_COLLISION,
    });
    expect(refusal.receiptPath).not.toBe(winner.receiptPath);
    await writeHalogenRunReceipt(winner.receiptPath, { ...common, pass: true, result: 'winner' });
    const refusalReceipt = JSON.parse(await readFile(refusal.receiptPath, 'utf8')) as Record<string, unknown>;
    expect(refusalReceipt).toMatchObject({
      pass: false,
      status: 'refused',
      attemptedRun: runName,
      reason: HALOGEN_RUN_IDENTITY_COLLISION,
      collision: 'claim',
      receipt: refusal.receiptPath,
    });
    expect(JSON.parse(await readFile(winner.receiptPath, 'utf8'))).toMatchObject({ pass: true, result: 'winner' });
    expect((await stat(refusal.receiptPath)).mode & 0o777).toBe(0o600);
  });
});
