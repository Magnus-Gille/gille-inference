import type { TaskDefinition } from '../types.js';

// Every person, organization, address, and commercial detail in this file is synthetic test data.

// ─── Delegated Work Tasks ─────────────────────────────────────────────────────
//
// These tasks simulate work that a coordinator (Claude/Codex) would delegate
// to a cheaper or more private local model. The key question per task:
// "Is model X smart enough to do this unsupervised?"
//
// Categories:
//   coding (d3)      — Medium-complexity implementation from a spec
//   test-gen         — Generate tests for existing code
//   code-review      — Substantive review with actionable feedback
//   research         — Compare options, summarize findings, assess tradeoffs
//   summarize        — PR/commit/changelog summarization
//   port             — Translate code between languages or frameworks

export const DELEGATED_TASKS: TaskDefinition[] = [
  // ---------------------------------------------------------------------------
  // delegated-code-001: Medium-complexity coding — caching layer with TTL
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-code-001',
    category: 'simple-coding',
    title: 'Implement an in-memory cache with TTL and LRU eviction',
    difficulty: 3,
    maxTokens: 4096,
    tags: ['delegated', 'coding', 'typescript', 'data-structure'],
    prompt: `Implement a TypeScript class \`Cache<T>\` with the following spec:

\`\`\`typescript
interface CacheOptions {
  maxSize: number;       // max entries before LRU eviction
  defaultTtlMs: number;  // default TTL in milliseconds
}

class Cache<T> {
  constructor(options: CacheOptions);
  get(key: string): T | undefined;      // returns undefined if missing or expired
  set(key: string, value: T, ttlMs?: number): void;  // optional per-key TTL override
  delete(key: string): boolean;
  has(key: string): boolean;             // false if expired
  clear(): void;
  get size(): number;                    // only non-expired entries
}
\`\`\`

Requirements:
- Expired entries should be lazily cleaned up on access (get/has), not via timers
- When maxSize is exceeded, evict the least recently used non-expired entry
- \`get\` should refresh the entry's position in the LRU order (it was "used")
- \`size\` should return count of non-expired entries (trigger a sweep)
- Must be O(1) for get/set (use a Map for ordering — JS Maps preserve insertion order)
- No external dependencies
- Include JSDoc comments on the class and constructor only`,
    expectedCapabilities: [
      'implements LRU eviction correctly',
      'implements TTL expiry correctly',
      'get refreshes LRU position',
      'lazy cleanup on access, not timers',
      'size triggers sweep of expired entries',
      'O(1) get/set using Map insertion order',
      'handles edge cases: get expired key, set on full cache',
      'per-key TTL override works',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-code-002: Implement a retry wrapper with backoff
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-code-002',
    category: 'simple-coding',
    title: 'Implement async retry with exponential backoff',
    difficulty: 3,
    maxTokens: 3000,
    tags: ['delegated', 'coding', 'typescript', 'async'],
    prompt: `Implement a TypeScript function:

\`\`\`typescript
interface RetryOptions {
  maxRetries: number;          // max number of retries (not counting initial attempt)
  initialDelayMs: number;      // delay before first retry
  maxDelayMs: number;          // cap on delay
  backoffMultiplier: number;   // multiply delay each retry (e.g. 2 for exponential)
  jitterFraction: number;      // 0-1, adds random jitter as fraction of current delay
  retryOn?: (error: unknown) => boolean;  // optional predicate — retry only if true
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T>;
\`\`\`

Requirements:
- First call to \`fn()\` is attempt 1 (not a retry). If it succeeds, return immediately.
- On failure, wait \`initialDelayMs\`, then retry. Each subsequent retry multiplies the delay by \`backoffMultiplier\`, capped at \`maxDelayMs\`.
- Jitter: add a random amount between 0 and \`jitterFraction * currentDelay\` to each wait.
- If \`retryOn\` is provided, only retry when it returns true for the error. Otherwise, rethrow immediately.
- After exhausting all retries, throw the last error.
- No external dependencies.`,
    expectedCapabilities: [
      'initial attempt is not counted as a retry',
      'exponential backoff with correct multiplier',
      'delay capped at maxDelayMs',
      'jitter applied correctly (additive, random)',
      'retryOn predicate respected — non-retryable errors thrown immediately',
      'last error thrown after exhausting retries',
      'no race conditions or leaked promises',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-code-003: Parse and transform a config file
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-code-003',
    category: 'simple-coding',
    title: 'Config file parser with env var interpolation and validation',
    difficulty: 3,
    maxTokens: 4096,
    tags: ['delegated', 'coding', 'typescript', 'parsing'],
    prompt: `Implement a TypeScript config loader:

\`\`\`typescript
interface FieldSchema {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;       // default true
  default?: string | number | boolean;
  env?: string;             // environment variable to read from
}

interface ConfigSchema {
  [key: string]: FieldSchema;
}

interface ConfigResult<T> {
  ok: true;
  config: T;
} | {
  ok: false;
  errors: string[];   // human-readable error messages
}

function loadConfig<T extends Record<string, unknown>>(
  raw: Record<string, string>,  // e.g. parsed from a .env or YAML file
  schema: ConfigSchema
): ConfigResult<T>;
\`\`\`

The function should:
1. For each field in schema: look up \`raw[key]\`, or \`process.env[field.env]\` if \`env\` is specified, or \`field.default\`
2. Priority: raw value > env var > default > missing
3. Coerce strings to the declared type (\`"true"/"false"\` for boolean, \`parseFloat\` for number)
4. Validate: required fields must be present after resolution, numbers must not be NaN
5. Return all errors at once (don't stop at first error)
6. On success, return the typed config object`,
    expectedCapabilities: [
      'correct priority: raw > env > default',
      'type coercion for boolean and number',
      'NaN detection for number fields',
      'collects all errors, not just first',
      'handles optional fields with defaults',
      'handles missing required fields',
      'returns typed result',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-test-001: Generate tests for existing code
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-test-001',
    category: 'simple-coding',
    title: 'Generate vitest tests for a utility module',
    difficulty: 3,
    maxTokens: 4096,
    tags: ['delegated', 'test-generation', 'typescript', 'vitest'],
    prompt: `Write comprehensive vitest tests for this module:

\`\`\`typescript
// src/utils/slug.ts
export function slugify(input: string, options?: { maxLength?: number; separator?: string }): string {
  const sep = options?.separator ?? '-';
  let slug = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[åä]/g, 'a')
    .replace(/[ö]/g, 'o')
    .replace(/[^a-z0-9]+/g, sep)       // non-alphanumeric → separator
    .replace(new RegExp(\`\${sep}+\`, 'g'), sep)  // collapse multiple separators
    .replace(new RegExp(\`^\${sep}|\${sep}$\`, 'g'), '');  // trim leading/trailing

  if (options?.maxLength && slug.length > options.maxLength) {
    slug = slug.slice(0, options.maxLength).replace(new RegExp(\`\${sep}$\`), '');
  }

  return slug;
}

export function generateUniqueSlug(
  base: string,
  existingSlugs: Set<string>,
  options?: { maxLength?: number; separator?: string }
): string {
  const baseSlug = slugify(base, options);
  if (!existingSlugs.has(baseSlug)) return baseSlug;

  let counter = 2;
  while (true) {
    const candidate = \`\${baseSlug}\${options?.separator ?? '-'}\${counter}\`;
    if (!existingSlugs.has(candidate)) return candidate;
    counter++;
  }
}
\`\`\`

Requirements for the tests:
- Use \`describe\`/\`it\` blocks, grouped by function
- Cover: basic conversion, Swedish characters (åäö), diacritics, edge cases (empty string, all special chars), maxLength with word-boundary-aware truncation, custom separator, consecutive separators
- For \`generateUniqueSlug\`: test deduplication, counter incrementing, interaction with maxLength
- Each test should have a descriptive name that explains the case, not the implementation
- Use \`expect(...).toBe(...)\` style assertions`,
    expectedCapabilities: [
      'tests both slugify and generateUniqueSlug',
      'covers Swedish characters åäö correctly',
      'tests diacritic stripping (e.g. café → cafe)',
      'tests edge cases: empty string, only special chars',
      'tests maxLength truncation without trailing separator',
      'tests custom separator',
      'tests generateUniqueSlug counter incrementing',
      'descriptive test names',
      'valid vitest syntax',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-test-002: Generate tests from a bug report
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-test-002',
    category: 'debugging',
    title: 'Write regression tests from a bug report',
    difficulty: 3,
    maxTokens: 3000,
    tags: ['delegated', 'test-generation', 'regression', 'vitest'],
    prompt: `A bug was reported and fixed. Write regression tests to prevent it from recurring.

Bug report:
"The date range filter in our API returns wrong results for queries spanning midnight UTC. For example, querying events between 2026-03-31T23:00:00Z and 2026-04-01T01:00:00Z returns no results even though events exist at 2026-03-31T23:30:00Z and 2026-04-01T00:15:00Z."

The fixed code:
\`\`\`typescript
// src/utils/date-range.ts
export interface DateRange {
  start: Date;
  end: Date;
}

export function isWithinRange(timestamp: Date, range: DateRange): boolean {
  return timestamp >= range.start && timestamp <= range.end;
}

export function filterByDateRange<T>(
  items: T[],
  getTimestamp: (item: T) => Date,
  range: DateRange
): T[] {
  if (range.start > range.end) {
    throw new Error('Invalid range: start must be before end');
  }
  return items.filter(item => isWithinRange(getTimestamp(item), range));
}
\`\`\`

Write vitest tests that:
1. Reproduce the original bug scenario (midnight-spanning query)
2. Test boundary conditions (exactly at start, exactly at end, 1ms before, 1ms after)
3. Test the error case (start > end)
4. Test with empty input and single-item input
5. Test across DST boundaries if relevant`,
    expectedCapabilities: [
      'reproduces the midnight UTC crossing scenario',
      'tests exact boundary inclusion (>= and <=)',
      'tests 1ms outside boundaries',
      'tests start > end error case',
      'tests empty array input',
      'uses realistic timestamps, not just round numbers',
      'valid vitest syntax',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-review-001: Substantive code review of a diff
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-review-001',
    category: 'non-coding',
    title: 'Code review a feature diff with actionable feedback',
    difficulty: 3,
    maxTokens: 3000,
    tags: ['delegated', 'code-review', 'feedback'],
    prompt: `Review this pull request diff. Provide actionable feedback — not just "looks good" but specific issues, suggestions, and questions. Prioritize: security > correctness > performance > style.

PR Title: "Add API key authentication middleware"
PR Description: "Adds API key auth to protect our internal endpoints."

\`\`\`diff
--- /dev/null
+++ b/src/middleware/auth.ts
@@ -0,0 +1,42 @@
+import { Request, Response, NextFunction } from 'express';
+
+const API_KEYS = [
+  'sk-prod-abc123def456',
+  'sk-prod-xyz789ghi012',
+  'sk-dev-test000000000',
+];
+
+const PUBLIC_PATHS = ['/health', '/metrics', '/api/v1/status'];
+
+export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
+  // Skip auth for public paths
+  if (PUBLIC_PATHS.includes(req.path)) {
+    return next();
+  }
+
+  const apiKey = req.headers['x-api-key'] as string;
+
+  if (!apiKey) {
+    return res.status(401).json({ error: 'API key required' });
+  }
+
+  if (API_KEYS.includes(apiKey)) {
+    console.log(\`Authenticated request with key: \${apiKey}\`);
+    next();
+  } else {
+    console.log(\`Failed auth attempt with key: \${apiKey}\`);
+    res.status(403).json({ error: 'Invalid API key' });
+  }
+}
+
+export function requireRole(role: string) {
+  return (req: Request, res: Response, next: NextFunction) => {
+    const userRole = req.headers['x-user-role'] as string;
+    if (userRole === role) {
+      next();
+    } else {
+      res.status(403).json({ error: 'Insufficient permissions' });
+    }
+  };
+}
\`\`\`

Provide your review as a list of findings, each with:
- Severity: CRITICAL / WARNING / SUGGESTION
- Line reference
- What's wrong and why
- How to fix it`,
    expectedCapabilities: [
      'CRITICAL: API keys hardcoded in source code (should be env vars or secrets manager)',
      'CRITICAL: logging the actual API key values (credential exposure in logs)',
      'CRITICAL: logging failed keys too (attacker could extract valid keys from log patterns)',
      'WARNING: API key comparison via includes() is not constant-time (timing attack)',
      'WARNING: requireRole trusts x-user-role header from client (trivially spoofable)',
      'WARNING: /metrics as a public path may expose sensitive operational data',
      'SUGGESTION: use a proper auth library or at minimum crypto.timingSafeEqual',
      'findings are actionable with specific fix suggestions',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-review-002: Review a database migration
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-review-002',
    category: 'non-coding',
    title: 'Review a database schema migration for safety',
    difficulty: 4,
    maxTokens: 2000,
    tags: ['delegated', 'code-review', 'database', 'migration'],
    prompt: `Review this SQLite migration for correctness and safety. This runs against a production database with ~500k rows in the users table.

\`\`\`sql
-- Migration: 003_add_subscription_tier.sql

-- Add subscription tier to users
ALTER TABLE users ADD COLUMN subscription_tier TEXT NOT NULL DEFAULT 'free';

-- Create index for filtering by tier
CREATE INDEX idx_users_subscription_tier ON users(subscription_tier);

-- Migrate existing premium users (identified by having a stripe_customer_id)
UPDATE users SET subscription_tier = 'premium' WHERE stripe_customer_id IS NOT NULL;

-- Add new subscriptions table
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tier TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT,
  stripe_subscription_id TEXT UNIQUE
);

-- Drop the old stripe column since it's now in subscriptions
ALTER TABLE users DROP COLUMN stripe_customer_id;
\`\`\`

Assess:
1. Will this migration succeed on SQLite specifically?
2. Is it safe to run on 500k rows?
3. Is the data migration correct?
4. Is anything destructive or irreversible?
5. What would you change?`,
    expectedCapabilities: [
      'identifies that ALTER TABLE DROP COLUMN is supported in SQLite >= 3.35.0 but should verify version',
      'flags that dropping stripe_customer_id is destructive and irreversible',
      'notes the UPDATE on 500k rows is fine in SQLite (single-writer, no lock contention)',
      'suggests the DROP should happen in a separate migration after verifying data was copied to subscriptions',
      'notes stripe_customer_id data is NOT being migrated to the subscriptions table — data loss',
      'suggests wrapping in a transaction',
      'suggests a rollback strategy or backup step',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-research-001: Compare libraries/approaches
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-research-001',
    category: 'non-coding',
    title: 'Compare technical approaches with tradeoff analysis',
    difficulty: 3,
    maxTokens: 3000,
    tags: ['delegated', 'research', 'analysis', 'comparison'],
    prompt: `I need to add full-text search to a Node.js application backed by SQLite. The database has ~100k documents (average 2KB each) and needs to support:
- Keyword search with relevance ranking
- Prefix matching (autocomplete)
- Swedish language content (å, ä, ö must work correctly)

Compare these options:
1. SQLite FTS5 (built-in)
2. MiniSearch (npm package, in-memory)
3. Lunr.js (npm package, in-memory)
4. Meilisearch (external service)

For each option, assess:
- Setup complexity
- Query performance at 100k documents
- Swedish language support
- Memory overhead
- Operational complexity (backups, updates, deployment)
- Failure modes

End with a clear recommendation for my use case and explain why.`,
    expectedCapabilities: [
      'accurate description of FTS5 capabilities including tokenizers',
      'correctly identifies Swedish language handling differences across options',
      'notes memory overhead for in-memory solutions at 100k x 2KB scale',
      'Meilisearch flagged as operational overhead (separate service)',
      'FTS5 recommended (already have SQLite, zero added deps, decent Swedish via unicode61)',
      'mentions FTS5 limitations honestly (no fuzzy matching, basic ranking)',
      'tradeoffs are specific, not generic pros/cons lists',
      'recommendation has clear reasoning tied to stated requirements',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-research-002: Assess a technical RFC/proposal
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-research-002',
    category: 'non-coding',
    title: 'Assess a technical proposal and identify risks',
    difficulty: 4,
    maxTokens: 3000,
    tags: ['delegated', 'research', 'architecture', 'risk-assessment'],
    prompt: `A team member proposed this architecture change. Assess it critically.

Proposal: "Migrate from REST to GraphQL"

Context:
- 15 REST endpoints serving a React dashboard and a mobile app
- 3 developers on the team, none have GraphQL experience
- Current pain point: mobile app makes 4-5 sequential REST calls per screen to assemble data
- Backend is Express + TypeScript + SQLite
- No dedicated DevOps — one developer handles deployment

Proposed plan:
1. Add Apollo Server alongside existing REST endpoints (2 weeks)
2. Create GraphQL schema mirroring current REST resources (1 week)
3. Migrate mobile app to GraphQL queries (3 weeks)
4. Migrate dashboard to GraphQL (2 weeks)
5. Deprecate REST endpoints (1 week)
Total estimate: 9 weeks

Assess:
1. Does the proposal solve the stated pain point?
2. Are the time estimates realistic?
3. What risks are not addressed?
4. What alternatives would solve the same problem with less risk?
5. Give a recommendation: proceed, modify, or reject — with reasoning.`,
    expectedCapabilities: [
      'identifies that the pain point (sequential calls) could be solved without GraphQL',
      'flags the time estimates as too optimistic (no GraphQL experience on team)',
      'notes the risk of running two API layers during migration',
      'suggests alternatives: composite REST endpoints, BFF pattern, or tRPC',
      'considers the team size and skill set in the recommendation',
      'flags N+1 query risk with GraphQL + SQLite',
      'notes that 3 developers + no DevOps + new tech stack = high risk',
      'recommendation is clear and justified',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-summary-001: Summarize a PR diff for changelog
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-summary-001',
    category: 'non-coding',
    title: 'Generate a commit message and changelog entry from a diff',
    difficulty: 2,
    maxTokens: 1000,
    tags: ['delegated', 'summarization', 'changelog', 'git'],
    prompt: `Generate (a) a conventional commit message and (b) a user-facing changelog entry from this diff.

\`\`\`diff
--- a/src/api/routes/invoices.ts
+++ b/src/api/routes/invoices.ts
@@ -45,10 +45,22 @@ router.get('/invoices', async (req, res) => {
   const { page = 1, limit = 20 } = req.query;
+  const { status, customer_id, date_from, date_to } = req.query;
+
+  let query = db.prepare('SELECT * FROM invoices WHERE 1=1');
+  const params: any[] = [];
+
+  if (status) {
+    query = db.prepare(query.source + ' AND status = ?');
+    params.push(status);
+  }
+  if (customer_id) {
+    query = db.prepare(query.source + ' AND customer_id = ?');
+    params.push(customer_id);
+  }
+  if (date_from) {
+    query = db.prepare(query.source + ' AND created_at >= ?');
+    params.push(date_from);
+  }
+  if (date_to) {
+    query = db.prepare(query.source + ' AND created_at <= ?');
+    params.push(date_to);
+  }

--- a/src/api/routes/invoices.test.ts
+++ b/src/api/routes/invoices.test.ts
@@ -12,6 +12,45 @@ describe('GET /invoices', () => {
+  it('filters by status', async () => {
+    const res = await request(app).get('/invoices?status=paid');
+    expect(res.status).toBe(200);
+    expect(res.body.every((inv: any) => inv.status === 'paid')).toBe(true);
+  });
+
+  it('filters by customer_id', async () => {
+    const res = await request(app).get('/invoices?customer_id=cust_123');
+    expect(res.status).toBe(200);
+  });
+
+  it('filters by date range', async () => {
+    const res = await request(app).get('/invoices?date_from=2026-01-01&date_to=2026-03-31');
+    expect(res.status).toBe(200);
+  });
\`\`\`

Output format:
1. Conventional commit message (type(scope): description)
2. Changelog entry (1-2 sentences for end users, in present tense)`,
    expectedCapabilities: [
      'commit message uses correct conventional format: feat(invoices): ...',
      'commit message mentions filtering, not just "update"',
      'changelog entry is user-facing (not code-level detail)',
      'changelog mentions the specific filter options added',
      'both are concise',
      'does not describe the test changes in the changelog (internal detail)',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-summary-002: Summarize a technical discussion into a decision
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-summary-002',
    category: 'non-coding',
    title: 'Distill a long technical thread into a decision record',
    difficulty: 3,
    maxTokens: 2000,
    tags: ['delegated', 'summarization', 'decision-record', 'adr'],
    prompt: `Distill this Slack thread into an Architecture Decision Record (ADR).

Thread:
[09:14] Morgan: We need to figure out how to handle background jobs. Right now the invoice reminder emails are sent synchronously in the API request handler and it's causing 504 timeouts.

[09:18] Taylor: Can we just use a cron job? Run every 5 minutes, check for pending reminders, send them.

[09:21] Morgan: That would work but we'd need to be careful about duplicate sends. What if the cron runs twice? Also we'll need more job types soon — PDF generation, report exports.

[09:25] Alex: BullMQ is the standard for Node.js queues. Redis-backed, retries, dead letter queue.

[09:28] Taylor: Do we really need Redis? That's another service to run. We're on a Pi with 8GB RAM.

[09:31] Morgan: Good point. What about a SQLite-backed queue? We already have SQLite.

[09:35] Alex: There are a few: better-queue, bree, or we roll our own with a jobs table. The SQLite WAL mode handles concurrent reads fine.

[09:42] Taylor: I like the jobs table idea. Simple, no new deps, we can inspect the queue with plain SQL. We just need: id, type, payload, status, created_at, run_at, attempts, last_error.

[09:45] Morgan: Let's go with that. Taylor, can you spec the table and the worker loop? Keep it simple — poll every 10 seconds, max 3 retries with exponential backoff. We can always upgrade to BullMQ later if we outgrow it.

[09:47] Alex: Fine with me. Just make sure failed jobs are visible somewhere so we notice.

[09:48] Taylor: Will do. I'll add a /admin/jobs endpoint too.

ADR format:
# ADR-NNN: [Title]
## Status
## Context
## Options Considered
## Decision
## Consequences`,
    expectedCapabilities: [
      'title captures the decision (SQLite job queue, not just "background jobs")',
      'context explains the problem (synchronous email sending causing 504s)',
      'lists all options discussed: cron, BullMQ/Redis, SQLite jobs table',
      'decision clearly states SQLite jobs table with polling',
      'includes key parameters: 10s poll interval, 3 retries, exponential backoff',
      'consequences mention the upgrade path to BullMQ',
      'consequences mention the monitoring endpoint',
      'captures the constraint that drove the decision (Pi with 8GB, no Redis)',
    ],
  },

  // ---------------------------------------------------------------------------
  // delegated-port-001: Port code between languages
  // ---------------------------------------------------------------------------
  {
    id: 'delegated-port-001',
    category: 'simple-coding',
    title: 'Port a Python utility to TypeScript',
    difficulty: 3,
    maxTokens: 3000,
    tags: ['delegated', 'porting', 'python', 'typescript'],
    prompt: `Port this Python utility to idiomatic TypeScript. Preserve the behavior exactly but use TypeScript conventions (interfaces, proper types, no any).

\`\`\`python
import re
from dataclasses import dataclass
from typing import Optional

@dataclass
class ParsedUrl:
    scheme: str
    host: str
    port: Optional[int]
    path: str
    query: dict[str, list[str]]
    fragment: Optional[str]

def parse_url(url: str) -> ParsedUrl:
    """Parse a URL into components. Handles edge cases that urllib misses."""
    pattern = r'^(https?):\/\/([^:/?#]+)(?::(\d+))?(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$'
    m = re.match(pattern, url)
    if not m:
        raise ValueError(f"Invalid URL: {url}")

    scheme, host, port_str, path, query_str, fragment = m.groups()

    # Parse query string
    query: dict[str, list[str]] = {}
    if query_str:
        for param in query_str.split('&'):
            if '=' in param:
                key, value = param.split('=', 1)
            else:
                key, value = param, ''
            key = _url_decode(key)
            value = _url_decode(value)
            query.setdefault(key, []).append(value)

    return ParsedUrl(
        scheme=scheme,
        host=host.lower(),
        port=int(port_str) if port_str else None,
        path=path or '/',
        query=query,
        fragment=fragment,
    )

def _url_decode(s: str) -> str:
    """Decode percent-encoded string."""
    result = []
    i = 0
    while i < len(s):
        if s[i] == '%' and i + 2 < len(s):
            try:
                result.append(chr(int(s[i+1:i+3], 16)))
                i += 3
                continue
            except ValueError:
                pass
        elif s[i] == '+':
            result.append(' ')
            i += 1
            continue
        result.append(s[i])
        i += 1
    return ''.join(result)
\`\`\`

Requirements:
- Use TypeScript interfaces, not classes with decorators
- The regex and parsing logic must produce identical results
- Use \`function\` declarations, not arrow functions at module level
- Include the same edge case handling (+ as space, bare query params without =)
- No external dependencies (don't use URL or URLSearchParams)`,
    expectedCapabilities: [
      'interface used instead of dataclass',
      'Optional fields use T | null or T | undefined',
      'query is Record<string, string[]>',
      'regex is identical in behavior',
      'url_decode handles %XX and + correctly',
      'host lowercased',
      'default path is "/"',
      'query params without = get empty string value',
      'no any types',
      'idiomatic TypeScript style',
    ],
  },
];
