import { buildCohortRuns, isoSecond, refId } from './core.mjs';

const API_VERSION = '2022-11-28';
const PER_PAGE = 100;
const MAX_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 5000;

export class GitHubApiError extends Error {
  constructor(status, path) {
    super(`GitHub Actions API returned HTTP ${status} for ${path}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.path = path;
  }
}

async function pause(milliseconds) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function fetchJsonWithRetry(fetcher, url, options, { retries = MAX_RETRIES, sleep = pause, deadline = Number.POSITIVE_INFINITY } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('Actions collection time budget exhausted');
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new DOMException('Actions request timed out', 'TimeoutError')),
        Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
      );
      let response;
      try {
        response = await fetcher(url, { ...options, redirect: 'error', signal: controller.signal });
        if (response.ok) return await response.json();
      } finally {
        clearTimeout(timeout);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) throw new GitHubApiError(response.status, new URL(url).pathname);
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 1500) : 250 * (attempt + 1);
      if (Date.now() + delay >= deadline) throw new Error('Actions collection time budget exhausted');
      await sleep(delay);
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      lastError = error;
      if (attempt === retries) break;
      const delay = 250 * (attempt + 1);
      if (Date.now() + delay >= deadline) throw new Error('Actions collection time budget exhausted');
      await sleep(delay);
    }
  }
  throw new Error(`GitHub Actions API request failed after ${retries + 1} attempts: ${lastError?.name ?? 'network error'}`);
}

function apiUrl(path, params = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function authOptions(token) {
  return {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
    },
  };
}

async function listPages(fetcher, token, path, params, collectionKey, maxRows, deadline) {
  const firstUrl = apiUrl(path, { ...params, per_page: PER_PAGE, page: 1 });
  const first = await fetchJsonWithRetry(fetcher, firstUrl, authOptions(token), { deadline });
  const total = first.total_count;
  if (!Number.isSafeInteger(total) || total < 0) throw new TypeError(`Actions API ${collectionKey} response has no valid total_count`);
  if (total > maxRows) throw new RangeError(`Actions API ${collectionKey} cohort exceeds the ${maxRows}-row evidence bound`);
  if (!Array.isArray(first[collectionKey])) throw new TypeError(`Actions API response lacks ${collectionKey}`);
  const results = [...first[collectionKey]];
  const identifiers = new Set();
  for (const row of results) {
    const id = Number(row?.id);
    if (!Number.isSafeInteger(id) || id < 1 || identifiers.has(id)) throw new TypeError(`Actions API ${collectionKey} contains an invalid or duplicate id`);
    identifiers.add(id);
  }
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  for (let page = 2; page <= pageCount; page += 1) {
    const next = await fetchJsonWithRetry(fetcher, apiUrl(path, { ...params, per_page: PER_PAGE, page }), authOptions(token), { deadline });
    if (next.total_count !== total || !Array.isArray(next[collectionKey])) {
      throw new TypeError(`Actions API ${collectionKey} page enumeration changed while collecting`);
    }
    for (const row of next[collectionKey]) {
      const id = Number(row?.id);
      if (!Number.isSafeInteger(id) || id < 1 || identifiers.has(id)) throw new TypeError(`Actions API ${collectionKey} contains an invalid or duplicate id`);
      identifiers.add(id);
      results.push(row);
    }
  }
  if (results.length !== total) throw new TypeError(`Actions API ${collectionKey} enumeration incomplete: ${results.length} of ${total}`);
  return { totalCount: total, pageCount, rows: results };
}

export async function enumerateWorkflowRuns({ fetcher = fetch, token, owner, repo, workflow, start, end, deadline = Number.POSITIVE_INFINITY }) {
  if (!token) throw new TypeError('a read-only GitHub token is required for Actions enumeration');
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) {
    throw new TypeError('Actions cohort requires a valid, nonempty half-open time window');
  }
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);
  const params = {
    branch: 'main',
    event: 'push',
    created: `${startDate}..${endDate}`,
  };
  const result = await listPages(fetcher, token, path, params, 'workflow_runs', 1000, deadline);
  for (const run of result.rows) {
    if (run.event !== 'push' || run.head_branch !== 'main') throw new TypeError(`workflow run ${run.id} violates the requested push/main cohort`);
    if (run.repository?.full_name && run.repository.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new TypeError(`workflow run ${run.id} belongs to an unexpected repository`);
    }
    if (run.path && run.path.split('@')[0] !== `.github/workflows/${workflow}`) {
      throw new TypeError(`workflow run ${run.id} uses an unexpected workflow definition path`);
    }
    if (!Number.isFinite(Date.parse(run.created_at ?? ''))) throw new TypeError(`workflow run ${run.id} has an invalid creation timestamp`);
  }
  const windowRuns = result.rows.filter(run => {
    const createdAt = Date.parse(run.created_at ?? '');
    return createdAt >= Date.parse(start) && createdAt < Date.parse(end);
  });
  return {
    ...result,
    query: { workflow, branch: 'main', event: 'push', start, end },
    windowRuns,
    windowCount: windowRuns.length,
  };
}

export async function getFirstAttempt({ fetcher = fetch, token, owner, repo, runId, deadline = Number.POSITIVE_INFINITY }) {
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`;
  const attempt = await fetchJsonWithRetry(fetcher, apiUrl(`${prefix}/attempts/1`), authOptions(token), { deadline });
  if (attempt.run_attempt !== 1) throw new TypeError(`Actions API returned attempt ${attempt.run_attempt} for requested attempt 1`);
  const jobs = await listPages(fetcher, token, `${prefix}/attempts/1/jobs`, { filter: 'all' }, 'jobs', 100, deadline);
  return {
    status: attempt.status ?? 'completed',
    conclusion: attempt.conclusion ?? null,
    runAttempt: attempt.run_attempt,
    jobs: jobs.rows,
    jobPageCount: jobs.pageCount,
  };
}

function inWindow(stamp, start, end) {
  const value = Date.parse(stamp ?? '');
  return Number.isFinite(value) && value >= Date.parse(start) && value < Date.parse(end);
}

export async function buildFirstAttemptEvidence({
  enumeration,
  attempts,
  workflowConfigForCommit,
  expectedWorkflowDigest,
  expectedJobRefs,
  jobNameToRef,
  start,
  end,
}) {
  if (enumeration.windowCount !== enumeration.windowRuns.length) throw new TypeError('workflow run inventory count changed');
  if (enumeration.totalCount > 1000) throw new RangeError('complete Actions run inventory exceeds contract limit');
  const configByCommit = new Map();
  const selected = [];
  const excluded = [];
  for (const run of enumeration.windowRuns) {
    if (!inWindow(run.created_at, start, end)) throw new TypeError(`run ${run.id} is outside the declared window`);
    if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw new TypeError(`run ${run.id} has no immutable head SHA`);
    let configDigest = configByCommit.get(run.head_sha);
    if (!configByCommit.has(run.head_sha)) {
      configDigest = await workflowConfigForCommit(run.head_sha);
      if (!/^[a-f0-9]{64}$/.test(configDigest ?? '')) throw new TypeError(`cannot verify workflow definition at ${run.head_sha}`);
      configByCommit.set(run.head_sha, configDigest);
    }
    if (configDigest === expectedWorkflowDigest) selected.push(run);
    else excluded.push({ run_id: Number(run.id), commit_sha: run.head_sha, created_at: isoSecond(new Date(run.created_at)), reason: 'workflow-definition-changed' });
  }

  const runs = buildCohortRuns({
    runs: selected,
    attempts,
    expectedJobRefs,
    jobNameToRef,
    windowStart: start,
    windowEnd: end,
  });
  const runEvidence = selected.map(run => {
    const first = attempts.get(Number(run.id)) ?? null;
    return {
      run_id: Number(run.id),
      attempt: 1,
      latest_attempt: Number(run.run_attempt),
      commit_sha: run.head_sha,
      created_at: isoSecond(new Date(run.created_at)),
      latest_status: run.status ?? null,
      latest_conclusion: run.conclusion ?? null,
      first_attempt_status: first?.status ?? null,
      first_attempt_conclusion: first?.conclusion ?? null,
      jobs: (first?.jobs ?? []).map(job => ({
        job_id: Number(job.id),
        name: job.name ?? null,
        status: job.status ?? null,
        conclusion: job.conclusion ?? null,
        started_at: job.started_at ? isoSecond(new Date(job.started_at)) : null,
        completed_at: job.completed_at ? isoSecond(new Date(job.completed_at)) : null,
      })),
    };
  });
  return {
    runs,
    evidence: {
      query: enumeration.query,
      api_total_count: enumeration.totalCount,
      api_page_count: enumeration.pageCount,
      window_run_count: enumeration.windowCount,
      selected_workflow_version_count: selected.length,
      excluded_workflow_version_count: excluded.length,
      selected_workflow_digest: expectedWorkflowDigest,
      workflow_config_cohorts: excluded,
      complete: true,
      runs: runEvidence,
    },
  };
}

export function ciPayload({ runs, workflowRef, workflowDigest, expectedJobRefs, start, end, inventoryRef }) {
  return {
    branch: 'main',
    event: 'push',
    workflow_ref: workflowRef,
    workflow_config_digest: { algorithm: 'sha256', value: workflowDigest },
    expected_job_refs: expectedJobRefs,
    window_start: start,
    window_end: end,
    runs,
    expected_run_count: runs.length,
    run_inventory_ref: inventoryRef,
  };
}

export function stableRunRef(runId) {
  return refId(`gha-run-${runId}-attempt-1`);
}
