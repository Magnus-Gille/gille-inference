import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MODELS, getModelById, getModelsByFamily, getLocalModels } from '../src/runner/models.js';

// ─── Model registry tests ─────────────────────────────────────────────────────

// Independent source of truth for the cloud-vs-local distinction — deliberately
// NOT derived from pricing, so a cloud model accidentally priced $0 cannot
// masquerade as local and skip the cloud-only id/pricing assertions below.
const LOCAL_ONLY_MODEL_IDS = new Set<string>([
  'google/gemma-4-e2b',
  'google/gemma-4-12b',
  'mellum2-12b-a2.5b-thinking',
  'mellum2-12b-a2.5b-instruct',
  'qwen3-coder-next-80b',
]);

describe('Model registry', () => {
  it('contains 19 models', () => {
    expect(MODELS).toHaveLength(19);
  });

  it('all models have valid IDs (non-empty, no whitespace; cloud models namespaced)', () => {
    for (const model of MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.id, `id "${model.id}" has whitespace`).not.toMatch(/\s/);
      // Cloud (OpenRouter) models use a "provider/model" id; local-only models
      // (in LOCAL_ONLY_MODEL_IDS) may carry a bare id like "mellum2-...".
      if (!LOCAL_ONLY_MODEL_IDS.has(model.id)) {
        expect(model.id, `cloud model "${model.id}" must be namespaced with "/"`).toContain('/');
      }
    }
  });

  it('all models have unique IDs', () => {
    const ids = MODELS.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all models have valid numeric fields (params > 0; cloud priced > 0, local priced 0)', () => {
    for (const model of MODELS) {
      expect(model.parametersBillions, model.id).toBeGreaterThan(0);
      expect(model.openRouterPricePerMInputToken, model.id).toBeGreaterThanOrEqual(0);
      expect(model.openRouterPricePerMOutputToken, model.id).toBeGreaterThanOrEqual(0);
      if (!LOCAL_ONLY_MODEL_IDS.has(model.id)) {
        // Cloud models are billed per-token; a $0 here would silently zero out
        // runBatch()'s cost accounting, so it must be strictly positive.
        expect(model.openRouterPricePerMInputToken, `cloud model "${model.id}" input price`).toBeGreaterThan(0);
        expect(model.openRouterPricePerMOutputToken, `cloud model "${model.id}" output price`).toBeGreaterThan(0);
      }
    }
  });

  it('LOCAL_ONLY_MODEL_IDS allowlist stays in sync with the registry', () => {
    // Guards against the allowlist rotting: every allowlisted id must exist and
    // actually be priced $0. A renamed/removed local model turns this red rather
    // than silently weakening the cloud assertions above.
    for (const id of LOCAL_ONLY_MODEL_IDS) {
      const model = getModelById(id);
      expect(model, `allowlisted local id "${id}" not found in registry`).toBeDefined();
      // Both price fields must be $0 — checking input alone would let a local
      // model with a non-zero output price slip through and be partially billed.
      expect(model!.openRouterPricePerMInputToken, `allowlisted "${id}" input price should be $0`).toBe(0);
      expect(model!.openRouterPricePerMOutputToken, `allowlisted "${id}" output price should be $0`).toBe(0);
    }
  });

  it('getModelById returns the correct model', () => {
    const model = getModelById('qwen/qwen3-14b');
    expect(model).toBeDefined();
    expect(model!.shortName).toBe('Qwen3-14B');
    expect(model!.family).toBe('qwen3');
    expect(model!.parametersBillions).toBe(14);
  });

  it('getModelById returns undefined for an unknown id', () => {
    expect(getModelById('not/real')).toBeUndefined();
  });

  it('getModelsByFamily returns all models in a family', () => {
    const qwen3 = getModelsByFamily('qwen3');
    expect(qwen3.length).toBeGreaterThanOrEqual(2);
    for (const m of qwen3) {
      expect(m.family).toBe('qwen3');
    }
  });

  it('getLocalModels(128) excludes models that do not fit in 128GB', () => {
    const models128 = getLocalModels(128);
    for (const m of models128) {
      expect(m.fitsIn128GB).toBe(true);
    }
    // Qwen3-235B-MoE and MiniMax-M2.5 do not fit in 128GB
    const ids = models128.map((m) => m.id);
    expect(ids).not.toContain('qwen/qwen3-235b-a22b');
    expect(ids).not.toContain('minimax/minimax-m2.5-20260211');
  });

  it('getLocalModels(256) returns all models (all remaining fit in 256GB)', () => {
    const models256 = getLocalModels(256);
    for (const m of models256) {
      expect(m.fitsIn256GB).toBe(true);
    }
  });

  it('getLocalModels(128) returns fewer models than getLocalModels(256)', () => {
    expect(getLocalModels(128).length).toBeLessThanOrEqual(getLocalModels(256).length);
  });

  it('Qwen3-235B-MoE fits 256GB but not 128GB', () => {
    const model = getModelById('qwen/qwen3-235b-a22b');
    expect(model).toBeDefined();
    expect(model!.fitsIn128GB).toBe(false);
    expect(model!.fitsIn256GB).toBe(true);
  });
});

// ─── Batch runner tests ───────────────────────────────────────────────────────

describe('Batch runner', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resume skips completed runs and does not call runInference again', async () => {
    // Mock the openrouter-client module
    const mockRunInference = vi.fn().mockResolvedValue({
      ok: true,
      response: 'test response',
      promptTokens: 100,
      completionTokens: 200,
      durationMs: 500,
      provider: 'test-provider',
    });

    vi.doMock('../src/runner/openrouter-client.js', () => ({
      runInference: mockRunInference,
    }));

    // Use an in-memory SQLite database for tests
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                TEXT PRIMARY KEY,
        batch_id          TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        model_id          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        prompt            TEXT NOT NULL,
        response          TEXT,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        duration_ms       INTEGER,
        ttft_ms           INTEGER,
        tokens_per_second REAL,
        cost_usd          REAL,
        provider          TEXT,
        error_message     TEXT,
        created_at        TEXT NOT NULL,
        completed_at      TEXT,
        UNIQUE(batch_id, task_id, model_id)
      )
    `);

    // Mock getDb to return the in-memory database
    vi.doMock('../src/db.js', () => ({
      getDb: () => db,
      initDb: () => db,
    }));

    const { runBatch } = await import('../src/runner/run-batch.js');

    // Pre-insert a completed run
    db.prepare(`
      INSERT INTO runs (id, batch_id, task_id, model_id, status, prompt, created_at, completed_at, response, prompt_tokens, completion_tokens, duration_ms)
      VALUES ('run-001', 'test-batch', 'simple-001', 'qwen/qwen3-14b', 'completed', 'test prompt', '2024-01-01T00:00:00Z', '2024-01-01T00:01:00Z', 'completed response', 50, 100, 1000)
    `).run();

    const result = await runBatch({
      batchId: 'test-batch',
      modelIds: ['qwen/qwen3-14b'],
      taskIds: ['simple-001'],
      concurrency: 1,
      resume: true,
    });

    // The completed run should be skipped
    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(0);
    expect(mockRunInference).not.toHaveBeenCalled();
  });

  it('failed runs are recorded with error message in the database', async () => {
    const mockRunInference = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Rate limit exceeded',
    });

    vi.doMock('../src/runner/openrouter-client.js', () => ({
      runInference: mockRunInference,
    }));

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                TEXT PRIMARY KEY,
        batch_id          TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        model_id          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        prompt            TEXT NOT NULL,
        response          TEXT,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        duration_ms       INTEGER,
        ttft_ms           INTEGER,
        tokens_per_second REAL,
        cost_usd          REAL,
        provider          TEXT,
        error_message     TEXT,
        created_at        TEXT NOT NULL,
        completed_at      TEXT,
        UNIQUE(batch_id, task_id, model_id)
      )
    `);

    vi.doMock('../src/db.js', () => ({
      getDb: () => db,
      initDb: () => db,
    }));

    const { runBatch } = await import('../src/runner/run-batch.js');

    const result = await runBatch({
      batchId: 'fail-batch',
      modelIds: ['qwen/qwen3-14b'],
      taskIds: ['simple-001'],
      concurrency: 1,
      resume: false,
    });

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);

    // Verify the database record
    const row = db.prepare(
      'SELECT status, error_message FROM runs WHERE batch_id = ? AND task_id = ? AND model_id = ?'
    ).get('fail-batch', 'simple-001', 'qwen/qwen3-14b') as { status: string; error_message: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.error_message).toBe('Rate limit exceeded');
  });

  it('successful runs are recorded with response and token counts', async () => {
    const mockRunInference = vi.fn().mockResolvedValue({
      ok: true,
      response: 'Here is the implementation...',
      promptTokens: 150,
      completionTokens: 300,
      durationMs: 2500,
      provider: 'openrouter',
    });

    vi.doMock('../src/runner/openrouter-client.js', () => ({
      runInference: mockRunInference,
    }));

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                TEXT PRIMARY KEY,
        batch_id          TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        model_id          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        prompt            TEXT NOT NULL,
        response          TEXT,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        duration_ms       INTEGER,
        ttft_ms           INTEGER,
        tokens_per_second REAL,
        cost_usd          REAL,
        provider          TEXT,
        error_message     TEXT,
        created_at        TEXT NOT NULL,
        completed_at      TEXT,
        UNIQUE(batch_id, task_id, model_id)
      )
    `);

    vi.doMock('../src/db.js', () => ({
      getDb: () => db,
      initDb: () => db,
    }));

    const { runBatch } = await import('../src/runner/run-batch.js');

    const result = await runBatch({
      batchId: 'success-batch',
      modelIds: ['qwen/qwen3-14b'],
      taskIds: ['simple-001'],
      concurrency: 1,
      resume: false,
    });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);

    const row = db.prepare(
      'SELECT status, response, prompt_tokens, completion_tokens, duration_ms, cost_usd, provider FROM runs WHERE batch_id = ? AND task_id = ? AND model_id = ?'
    ).get('success-batch', 'simple-001', 'qwen/qwen3-14b') as {
      status: string;
      response: string;
      prompt_tokens: number;
      completion_tokens: number;
      duration_ms: number;
      cost_usd: number;
      provider: string;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect(row!.response).toBe('Here is the implementation...');
    expect(row!.prompt_tokens).toBe(150);
    expect(row!.completion_tokens).toBe(300);
    expect(row!.duration_ms).toBe(2500);
    expect(row!.cost_usd).toBeGreaterThan(0);
    expect(row!.provider).toBe('openrouter');
  });
});
