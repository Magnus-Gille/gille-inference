import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('M5 remote build worker security contract', () => {
  it('passes the offline Python regression suite', () => {
    const result = spawnSync('python3', ['tests/test_m5_build_worker.py'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
    });
    expect(result.stdout + result.stderr).not.toContain('FAILED');
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
