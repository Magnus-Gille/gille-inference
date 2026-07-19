import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  checkOllamaHealth,
  getOllamaVersion,
  getLoadedModels,
  listOllamaModels,
  MIN_OLLAMA_VERSION,
} from './local-client.js';

const execFileAsync = promisify(execFile);

// ─── Version comparison ───────────────────────────────────────────────────────

function parseVersion(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10));
}

function versionGte(actual: string, required: string): boolean {
  const a = parseVersion(actual);
  const r = parseVersion(required);
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const av = a[i] ?? 0;
    const rv = r[i] ?? 0;
    if (av > rv) return true;
    if (av < rv) return false;
  }
  return true; // equal
}

// ─── Memory check via vm_stat (macOS only) ────────────────────────────────────

interface MemoryStats {
  freeGb: number;
  inactiveGb: number;
  availableGb: number;
}

async function getMacOsMemoryStats(): Promise<MemoryStats | null> {
  try {
    const { stdout } = await execFileAsync('vm_stat');
    const pageSize = 16384; // 16KB on Apple Silicon
    const match = (label: string): number => {
      const m = stdout.match(new RegExp(`${label}[^:]*:\\s+(\\d+)`));
      return m ? parseInt(m[1]!, 10) * pageSize : 0;
    };
    const freeBytes = match('Pages free');
    const inactiveBytes = match('Pages inactive');
    const toGb = (b: number) => Math.round((b / 1024 / 1024 / 1024) * 10) / 10;
    return {
      freeGb: toGb(freeBytes),
      inactiveGb: toGb(inactiveBytes),
      availableGb: toGb(freeBytes + inactiveBytes),
    };
  } catch {
    return null;
  }
}

// ─── Check results ────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  pass: boolean;
  message: string;
  hint?: string;
}

// ─── Main preflight ───────────────────────────────────────────────────────────

export interface PreflightOptions {
  /** Ollama model names (as they appear in `ollama list`) to verify are pulled. */
  requiredModelNames: string[];
  /** If true, only warn on failures instead of returning pass=false. */
  warnOnly?: boolean;
}

export interface PreflightResult {
  passed: boolean;
  checks: CheckResult[];
}

/**
 * Run preflight checks for local Ollama benchmarking.
 * Prints a formatted report and returns pass/fail.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const { requiredModelNames, warnOnly = false } = options;
  const checks: CheckResult[] = [];

  // 1. Ollama reachable
  const healthy = await checkOllamaHealth();
  checks.push({
    name: 'Ollama reachable',
    pass: healthy,
    message: healthy ? 'Ollama is running at ' + (process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434') : 'Cannot reach Ollama',
    hint: healthy ? undefined : 'Start Ollama with the benchmarking env vars:\n    OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=-1 OLLAMA_LOAD_TIMEOUT=600 ollama serve',
  });

  // 2. Ollama version
  const version = await getOllamaVersion();
  const versionOk = version !== null && versionGte(version, MIN_OLLAMA_VERSION);
  checks.push({
    name: `Ollama version >= ${MIN_OLLAMA_VERSION}`,
    pass: versionOk,
    message: version ? `Version: ${version}` : 'Could not determine version',
    hint: versionOk ? undefined : `Upgrade Ollama: https://ollama.com/download\nRequired: >= ${MIN_OLLAMA_VERSION}`,
  });

  // 3. No models currently loaded (clean starting state)
  const loaded = await getLoadedModels();
  const cleanStart = loaded.length === 0;
  checks.push({
    name: 'No models pre-loaded',
    pass: cleanStart,
    message: cleanStart
      ? 'No models loaded (clean start)'
      : `${loaded.length} model(s) already in memory: ${loaded.join(', ')}`,
    hint: cleanStart ? undefined : 'Unload models or restart Ollama to start clean',
  });

  // 4. Required models are pulled
  const pulledModels = await listOllamaModels();
  for (const requiredName of requiredModelNames) {
    // Match by prefix — "gemma4:e2b" matches "gemma4:e2b" or "gemma4:e2b-..." etc.
    const isPulled = pulledModels.some((m) => m === requiredName || m.startsWith(requiredName + ':') || m.startsWith(requiredName.split(':')[0]!));
    checks.push({
      name: `Model pulled: ${requiredName}`,
      pass: isPulled,
      message: isPulled ? `Found: ${pulledModels.find((m) => m.startsWith(requiredName.split(':')[0]!)) ?? requiredName}` : `Not found in local library`,
      hint: isPulled ? undefined : `Pull it: ollama pull ${requiredName}`,
    });
  }

  // 5. Benchmarking env vars set
  const maxLoaded = process.env['OLLAMA_MAX_LOADED_MODELS'];
  const numParallel = process.env['OLLAMA_NUM_PARALLEL'];
  const envOk = maxLoaded === '1' && numParallel === '1';
  checks.push({
    name: 'Benchmarking env vars set',
    pass: envOk,
    message: envOk
      ? 'OLLAMA_MAX_LOADED_MODELS=1, OLLAMA_NUM_PARALLEL=1'
      : `OLLAMA_MAX_LOADED_MODELS=${maxLoaded ?? '(unset)'}, OLLAMA_NUM_PARALLEL=${numParallel ?? '(unset)'}`,
    hint: envOk ? undefined : [
      'Set before starting Ollama:',
      '    export OLLAMA_MAX_LOADED_MODELS=1',
      '    export OLLAMA_NUM_PARALLEL=1',
      '    export OLLAMA_KEEP_ALIVE=-1',
      '    export OLLAMA_LOAD_TIMEOUT=600',
      'Or use scripts/run-local-benchmark.sh which sets these automatically.',
    ].join('\n'),
  });

  // 6. Available memory (macOS only)
  const memStats = await getMacOsMemoryStats();
  if (memStats !== null) {
    const memOk = memStats.availableGb >= 8; // rough threshold — smallest useful model needs ~3-4GB
    checks.push({
      name: 'Available memory >= 8 GB',
      pass: memOk,
      message: `Available: ${memStats.availableGb} GB (free: ${memStats.freeGb} GB, inactive: ${memStats.inactiveGb} GB)`,
      hint: memOk ? undefined : 'Close other applications to free memory before benchmarking',
    });
  }

  // ─── Print report ─────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(60));
  console.log('Preflight checks:');
  console.log('─'.repeat(60));

  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? '✓' : (warnOnly ? '⚠' : '✗');
    console.log(`${icon}  ${check.name}`);
    console.log(`   ${check.message}`);
    if (!check.pass && check.hint) {
      for (const line of check.hint.split('\n')) {
        console.log(`   ${line}`);
      }
    }
    if (!check.pass) allPassed = false;
  }

  console.log('─'.repeat(60));
  if (allPassed) {
    console.log('All checks passed. Ready to benchmark.');
  } else if (warnOnly) {
    console.log('Some checks failed (warn-only mode — continuing anyway).');
  } else {
    console.log('Preflight FAILED. Fix the issues above before running a benchmark.');
  }
  console.log('─'.repeat(60) + '\n');

  return { passed: warnOnly ? true : allPassed, checks };
}
