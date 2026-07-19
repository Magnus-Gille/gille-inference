import type { CompoundTaskDefinition } from "../orchestrator/types.js";

export const COMPOUND_TASKS: CompoundTaskDefinition[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // ct-001: Feature + Tests + Review
  // Sub-tasks: (a) implement feature, (b) write tests, (c) review both
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-001",
    title: "Feature + Tests + Review",
    description:
      "Implement a TypeScript rate-limiter utility, write unit tests for it, then produce a code review of the implementation and tests.",
    subTasks: [
      {
        id: "ct-001-a",
        title: "Implement rate-limiter",
        promptTemplate: `Implement a TypeScript rate-limiter utility with the following interface:

\`\`\`typescript
interface RateLimiterOptions {
  maxRequests: number;   // max calls allowed in the window
  windowMs: number;      // rolling window duration in milliseconds
}

class RateLimiter {
  constructor(options: RateLimiterOptions);
  /** Returns true if the call is allowed, false if rate-limited */
  allow(key: string): boolean;
  /** Reset the counter for a specific key */
  reset(key: string): void;
  /** Return remaining calls allowed for a key in the current window */
  remaining(key: string): number;
}
\`\`\`

Requirements:
- Use a sliding window algorithm (not fixed window)
- Track per-key state in a Map
- Clean up expired entries automatically on each call
- No external dependencies
- Full TypeScript with strict types, no \`any\`

Provide only the implementation code, no test code.`,
        maxTokens: 2048,
      },
      {
        id: "ct-001-b",
        title: "Write unit tests",
        promptTemplate: `Here is a TypeScript rate-limiter implementation:

{{CT_001_A_OUTPUT}}

Write comprehensive vitest unit tests for this implementation. Cover:
- Basic allow/deny behaviour at the limit
- Sliding window: requests expire correctly after windowMs
- Per-key isolation (key A doesn't affect key B)
- reset() clears a key's history
- remaining() returns correct counts
- Edge cases: zero remaining, rapid bursts

Use \`vi.useFakeTimers()\` for time control. Import from 'vitest'. Do not modify the implementation — write tests that import it as a module named './rate-limiter.js'.`,
        maxTokens: 2048,
        dependsOn: ["ct-001-a"],
      },
      {
        id: "ct-001-c",
        title: "Code review",
        promptTemplate: `Review the following TypeScript rate-limiter implementation and its tests.

## Implementation
{{CT_001_A_OUTPUT}}

## Tests
{{CT_001_B_OUTPUT}}

Provide a structured code review covering:
1. Correctness of the sliding window algorithm
2. Edge cases that tests cover and any gaps
3. TypeScript type safety
4. Performance characteristics (time/space complexity)
5. Actionable improvement suggestions (max 5, ranked by priority)

Be concise and specific.`,
        maxTokens: 1024,
        dependsOn: ["ct-001-a", "ct-001-b"],
      },
    ],
    synthesisPromptTemplate: `You have coordinated a three-part software task. Below are the outputs from each stage.

## Implementation (by execution model)
{{CT_001_A_OUTPUT}}

## Tests (by execution model)
{{CT_001_B_OUTPUT}}

## Code Review (by execution model)
{{CT_001_C_OUTPUT}}

Produce a final deliverable: a single markdown document that contains:
1. The implementation code (include as-is or apply the top review suggestion if trivially safe)
2. The test code (include as-is)
3. A "Review Summary" section with the top 3 actionable items from the review

Format the document cleanly with section headers and fenced code blocks.`,
    synthesisSystemPrompt:
      "You are a senior engineering lead assembling a final deliverable from sub-task outputs. Be concise and preserve the substance of each sub-task output.",
    synthesisMaxTokens: 3072,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ct-002: Research and Recommend
  // Sub-tasks: (a) research options, (b) write recommendation
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-002",
    title: "Research and Recommend",
    description:
      "Research TypeScript HTTP client libraries suitable for a backend Node.js service, then write a recommendation memo.",
    subTasks: [
      {
        id: "ct-002-a",
        title: "Research HTTP client options",
        promptTemplate: `List and compare TypeScript/Node.js HTTP client libraries for a backend service. Focus on libraries commonly used in production as of 2024-2025.

For each library cover:
- Name, npm package name, weekly downloads (approximate)
- Bundle size and tree-shaking support
- TypeScript support (first-class vs community types)
- Retry/timeout/cancellation support
- Streaming support
- Notable limitations or known issues

Include at minimum: native fetch, axios, got, ky, undici, node-fetch.
Format as a comparison table followed by brief notes on each.`,
        maxTokens: 2048,
      },
      {
        id: "ct-002-b",
        title: "Write recommendation memo",
        promptTemplate: `You have the following research on Node.js HTTP client libraries:

{{CT_002_A_OUTPUT}}

Write a concise recommendation memo (max 400 words) for a team choosing an HTTP client for a new Node.js microservice. Context: TypeScript codebase, Node.js 22+, REST API calls to third-party services, needs retry logic and good TypeScript ergonomics, no browser bundle requirement.

Structure:
- Recommendation (1-2 sentences naming the choice)
- Rationale (3-4 bullet points)
- Runner-up and when to prefer it instead
- What to avoid and why`,
        maxTokens: 1024,
        dependsOn: ["ct-002-a"],
      },
    ],
    synthesisPromptTemplate: `Combine the following research and recommendation into a final technical memo.

## Library Comparison Research
{{CT_002_A_OUTPUT}}

## Recommendation Memo
{{CT_002_B_OUTPUT}}

Produce a clean final document with:
1. An executive summary (2 sentences)
2. The comparison table from the research (verbatim)
3. The recommendation memo (verbatim or lightly edited for flow)

Use markdown formatting.`,
    synthesisSystemPrompt:
      "You are a senior engineer producing a final technical memo. Preserve technical accuracy. Do not add opinion beyond what is in the inputs.",
    synthesisMaxTokens: 2048,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ct-003: Debug from Error + Fix + Test
  // Sub-tasks: (a) diagnose error, (b) write fix, (c) regression test
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-003",
    title: "Debug from Error + Fix + Test",
    description:
      "Diagnose a runtime error from a stack trace and code snippet, implement a fix, and write a regression test.",
    subTasks: [
      {
        id: "ct-003-a",
        title: "Diagnose the error",
        promptTemplate: `Diagnose the following Node.js runtime error.

## Stack trace
\`\`\`
TypeError: Cannot read properties of undefined (reading 'map')
    at processItems (/app/src/processor.ts:34:24)
    at async handleRequest (/app/src/server.ts:18:20)
\`\`\`

## Relevant code (processor.ts lines 28-42)
\`\`\`typescript
interface Item {
  id: string;
  value: number;
}

interface ApiResponse {
  data?: Item[];
  error?: string;
}

async function processItems(response: ApiResponse): Promise<number[]> {
  // Line 34:
  return response.data.map((item) => item.value * 2);
}
\`\`\`

Provide:
1. Root cause (one sentence)
2. Why TypeScript didn't catch it at compile time
3. Two possible fixes with trade-offs`,
        maxTokens: 1024,
      },
      {
        id: "ct-003-b",
        title: "Implement the fix",
        promptTemplate: `Here is a diagnosis of a TypeScript bug:

{{CT_003_A_OUTPUT}}

Implement the best fix for the \`processItems\` function. The function signature must remain:
\`\`\`typescript
async function processItems(response: ApiResponse): Promise<number[]>
\`\`\`

Requirements:
- Handle undefined/null \`data\` gracefully (return empty array)
- Make TypeScript enforce the guard at compile time (no type assertion)
- Keep the implementation minimal — do not restructure unrelated code

Provide only the fixed function, no surrounding code.`,
        maxTokens: 512,
        dependsOn: ["ct-003-a"],
      },
      {
        id: "ct-003-c",
        title: "Write regression test",
        promptTemplate: `Here is the original buggy code and the fix.

## Original diagnosis
{{CT_003_A_OUTPUT}}

## Fixed implementation
{{CT_003_B_OUTPUT}}

Write a vitest regression test suite for \`processItems\`. Cover:
- Happy path: data array with items → returns doubled values
- Empty data array → returns empty array
- Missing data field (undefined) → returns empty array
- null data → returns empty array
- Response with error field and no data → returns empty array

Import \`processItems\` from './processor.js'. Define the \`ApiResponse\` and \`Item\` interfaces inline in the test file.`,
        maxTokens: 1024,
        dependsOn: ["ct-003-a", "ct-003-b"],
      },
    ],
    synthesisPromptTemplate: `Combine the following debugging sub-tasks into a final bug report and fix document.

## Diagnosis
{{CT_003_A_OUTPUT}}

## Fix
{{CT_003_B_OUTPUT}}

## Regression Test
{{CT_003_C_OUTPUT}}

Produce a structured document:
1. **Bug Summary** — root cause in one sentence
2. **Fixed Code** — the corrected function
3. **Regression Tests** — the full test file
4. **Prevention Note** — one sentence on how to avoid this class of bug in future`,
    synthesisSystemPrompt:
      "You are assembling a bug report and fix. Be precise and concise.",
    synthesisMaxTokens: 2048,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ct-004: PR Review + Changelog
  // Sub-tasks: (a) review PR diff, (b) write changelog entry
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-004",
    title: "PR Review + Changelog",
    description:
      "Review a pull request diff for a TypeScript module, then write a changelog entry based on the review findings.",
    subTasks: [
      {
        id: "ct-004-a",
        title: "Review PR diff",
        promptTemplate: `Review the following pull request diff. The change adds a caching layer to an existing user service.

\`\`\`diff
--- a/src/user-service.ts
+++ b/src/user-service.ts
@@ -1,18 +1,42 @@
 import type { Database } from './db.js';
+import { LRUCache } from 'lru-cache';

 export interface User {
   id: string;
   email: string;
   name: string;
+  role: 'admin' | 'user';
 }

+const cache = new LRUCache<string, User>({ max: 1000 });
+
 export class UserService {
   constructor(private db: Database) {}

-  async getUser(id: string): Promise<User | null> {
-    return this.db.query<User>('SELECT * FROM users WHERE id = ?', [id]);
+  async getUser(id: string): Promise<User | null> {
+    const cached = cache.get(id);
+    if (cached) return cached;
+    const user = await this.db.query<User>('SELECT * FROM users WHERE id = ?', [id]);
+    if (user) cache.set(id, user);
+    return user;
+  }
+
+  async updateUser(id: string, data: Partial<Omit<User, 'id'>>): Promise<User | null> {
+    const updated = await this.db.execute<User>(
+      'UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), role = COALESCE(?, role) WHERE id = ? RETURNING *',
+      [data.email, data.name, data.role, id]
+    );
+    if (updated) cache.set(id, updated);
+    return updated;
   }
+
+  async deleteUser(id: string): Promise<boolean> {
+    const result = await this.db.execute('DELETE FROM users WHERE id = ?', [id]);
+    cache.delete(id);
+    return result !== null;
+  }
 }
\`\`\`

Provide a structured review:
1. Correctness issues (blocking)
2. Design concerns (non-blocking but important)
3. Minor suggestions
4. Summary verdict: approve / approve with comments / request changes`,
        maxTokens: 1536,
      },
      {
        id: "ct-004-b",
        title: "Write changelog entry",
        promptTemplate: `Based on this PR review, write a Keep a Changelog-formatted entry for the change.

## PR Review
{{CT_004_A_OUTPUT}}

Write a changelog entry under the [Unreleased] section for version 1.x. Use the standard Keep a Changelog categories (Added, Changed, Fixed, etc.). Be specific about what changed and its impact. Keep each bullet under 100 characters.`,
        maxTokens: 512,
        dependsOn: ["ct-004-a"],
      },
    ],
    synthesisPromptTemplate: `Combine the PR review and changelog entry into a final review document.

## PR Review
{{CT_004_A_OUTPUT}}

## Changelog Entry
{{CT_004_B_OUTPUT}}

Produce a final document:
1. **PR Review** (verbatim from above)
2. **Changelog** (verbatim from above)
3. **Merge Decision** — a single sentence verdict based on the review`,
    synthesisSystemPrompt:
      "You are a tech lead assembling a PR review record. Preserve all technical detail.",
    synthesisMaxTokens: 2048,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ct-005: Architecture Assessment
  // Sub-tasks: (a) identify trade-offs, (b) research alternatives, (c) write ADR
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-005",
    title: "Architecture Assessment",
    description:
      "Assess whether to use SQLite or PostgreSQL for a new single-user desktop app with local data, research the trade-offs, and write an Architecture Decision Record.",
    subTasks: [
      {
        id: "ct-005-a",
        title: "Identify trade-offs",
        promptTemplate: `A solo developer is building a desktop journaling app (Electron/Tauri) that stores personal notes, tags, and attachments locally on the user's machine. Expected data: up to 50k notes over 5 years, single user, no network access needed.

Identify the key trade-offs between SQLite and PostgreSQL for this use case. Structure your answer as:
- **SQLite pros/cons** (5 each, specific to this context)
- **PostgreSQL pros/cons** (5 each, specific to this context)
- **Decision factors** — what criteria matter most here`,
        maxTokens: 1536,
      },
      {
        id: "ct-005-b",
        title: "Research alternatives",
        promptTemplate: `For the same desktop journaling app context described here:
- Local-only desktop app (Electron/Tauri)
- Up to 50k notes, single user
- Needs full-text search on note content
- Stores attachments (up to 10MB each)

And given these trade-offs already identified:
{{CT_005_A_OUTPUT}}

Research two alternatives to PostgreSQL/SQLite that are worth considering:
1. One embedded database alternative (e.g., DuckDB, LevelDB, LMDB, PGlite)
2. One file-based approach (e.g., JSON files, markdown + git, plain files)

For each: describe the approach, its fit for this use case, and when you'd choose it over SQLite.`,
        maxTokens: 1536,
        dependsOn: ["ct-005-a"],
      },
      {
        id: "ct-005-c",
        title: "Write Architecture Decision Record",
        promptTemplate: `Write an Architecture Decision Record (ADR) for the database choice for a local desktop journaling app.

Use this context:
## Trade-offs identified
{{CT_005_A_OUTPUT}}

## Alternatives researched
{{CT_005_B_OUTPUT}}

Format the ADR with these sections:
- **Title** (ADR-001: ...)
- **Status** (Accepted)
- **Context** (2-3 sentences)
- **Decision** (the choice and the primary reason)
- **Consequences** (Positive / Negative / Neutral bullet lists)
- **Alternatives Considered** (one line each for the rejected options)`,
        maxTokens: 1536,
        dependsOn: ["ct-005-a", "ct-005-b"],
      },
    ],
    synthesisPromptTemplate: `Combine the architecture assessment sub-tasks into a final architecture report.

## Trade-offs Analysis
{{CT_005_A_OUTPUT}}

## Alternatives Research
{{CT_005_B_OUTPUT}}

## Architecture Decision Record
{{CT_005_C_OUTPUT}}

Produce a final document:
1. **Executive Summary** — 2 sentences on the recommendation
2. **Trade-offs Analysis** (verbatim)
3. **Alternatives** (verbatim)
4. **ADR** (verbatim)`,
    synthesisSystemPrompt:
      "You are a senior architect assembling a decision report. Preserve all technical detail.",
    synthesisMaxTokens: 3072,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ct-006: Code Port + Validation
  // Sub-tasks: (a) port Python to TypeScript, (b) verify correctness
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-006",
    title: "Code Port + Validation",
    description:
      "Port a Python data processing function to TypeScript, then validate the port is functionally equivalent.",
    subTasks: [
      {
        id: "ct-006-a",
        title: "Port Python to TypeScript",
        promptTemplate: `Port the following Python function to TypeScript. Preserve exact semantics.

\`\`\`python
from typing import Optional
from collections import defaultdict

def group_and_aggregate(
    records: list[dict],
    group_by: str,
    value_key: str,
    percentile: Optional[float] = None
) -> dict[str, dict]:
    """
    Group records by a key field and compute aggregates (count, sum, mean, min, max)
    for a numeric value field. Optionally compute an approximate percentile.
    """
    groups: dict[str, list[float]] = defaultdict(list)

    for record in records:
        key = str(record.get(group_by, "unknown"))
        try:
            value = float(record.get(value_key, 0))
            groups[key].append(value)
        except (TypeError, ValueError):
            continue  # skip non-numeric values

    result = {}
    for key, values in groups.items():
        sorted_values = sorted(values)
        n = len(sorted_values)
        agg: dict = {
            "count": n,
            "sum": sum(values),
            "mean": sum(values) / n if n > 0 else 0,
            "min": sorted_values[0] if n > 0 else None,
            "max": sorted_values[-1] if n > 0 else None,
        }
        if percentile is not None and n > 0:
            idx = int(percentile / 100 * (n - 1))
            agg["percentile"] = sorted_values[min(idx, n - 1)]
        result[key] = agg

    return result
\`\`\`

Requirements:
- Strict TypeScript with no \`any\`
- Preserve the \`percentile\` parameter behaviour (undefined = skip, 0-100 scale)
- Handle non-numeric values the same way (skip silently)
- Export the function and its types
- No external dependencies`,
        maxTokens: 2048,
      },
      {
        id: "ct-006-b",
        title: "Validate equivalence",
        promptTemplate: `Here is a TypeScript port of a Python function:

{{CT_006_A_OUTPUT}}

Validate that the TypeScript port is functionally equivalent to the original Python.

Provide:
1. A test matrix: for each of the 5 scenarios below, show the expected output from both Python (described) and TypeScript (the port above)
   - Empty records array
   - Single record
   - Multiple records, same group
   - Multiple records, multiple groups
   - Records with non-numeric values mixed in

2. Any semantic differences you spotted between the Python and TypeScript versions (be precise about line/behaviour)

3. A verdict: Equivalent / Equivalent with caveats / Not equivalent — with justification`,
        maxTokens: 1536,
        dependsOn: ["ct-006-a"],
      },
    ],
    synthesisPromptTemplate: `Combine the code port and validation into a final deliverable.

## TypeScript Port
{{CT_006_A_OUTPUT}}

## Equivalence Validation
{{CT_006_B_OUTPUT}}

Produce a final document:
1. **Port Status** — one sentence verdict from the validation
2. **TypeScript Implementation** — the final code (apply any corrections from the validation if needed)
3. **Equivalence Report** — the test matrix and verdict from the validation (verbatim)`,
    synthesisSystemPrompt:
      "You are a senior engineer finalising a code port. Preserve technical accuracy.",
    synthesisMaxTokens: 3072,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ct-007: Daily Briefing Generation
  // Sub-tasks: (a) extract key points, (b) generate briefing
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: "ct-007",
    title: "Daily Briefing Generation",
    description:
      "Extract key points from a set of technical updates, then generate a structured daily briefing document.",
    subTasks: [
      {
        id: "ct-007-a",
        title: "Extract key points",
        promptTemplate: `Extract the key actionable points from these technical updates. Separate signal from noise.

---
**Update 1 — Infrastructure (from DevOps)**
Redis cluster upgraded from 6.2 to 7.2 yesterday at 23:00 UTC. Zero downtime. New features available: Redis Functions, ACL enhancements, keyspace notifications improvements. Memory usage down 8% due to improved encoding. One issue: SINTERCARD command behaviour changed — returns count not members when LIMIT=0. Check any callers. Monitoring all green.

**Update 2 — Product (from PM)**
Sprint 47 ends Friday. 3 tickets in review, 2 still in progress (AUTH-441 login flow, DASH-203 export CSV). AUTH-441 is blocking the security audit scheduled for Monday. DASH-203 is nice-to-have. Customer NPS survey results in: 7.2 → 7.8, improvement driven by faster load times from last month's CDN work.

**Update 3 — Security (from SecOps)**
CVE-2024-3094 (xz/liblzma backdoor) — our Docker images are NOT affected (we use Alpine, not Debian/Fedora). Routine scan found 2 medium-severity npm packages needing updates: lodash 4.17.19→4.17.21 (prototype pollution fix, low exploitability in our usage), ws 7.4.5→8.x (breaking change in major version, needs migration). Action required on ws before next pentest in 6 weeks.

**Update 4 — Engineering (from Tech Lead)**
TypeScript 5.5 released. Key features: inferred type predicates, const params in JSDoc. No breaking changes for us. Upgrade is low risk. Node.js 18 EOL is April 2025 — we need to migrate to Node 20 LTS before then. Current status: dev/staging on Node 20, production still on Node 18.
---

For each update, list:
- Immediate actions required (blocking or time-sensitive)
- Non-urgent but important items
- Informational only (no action)`,
        maxTokens: 1024,
      },
      {
        id: "ct-007-b",
        title: "Generate daily briefing",
        promptTemplate: `Generate a structured daily engineering briefing from these extracted key points:

{{CT_007_A_OUTPUT}}

Format the briefing for an engineering manager. Use this structure:
# Daily Engineering Briefing — [DATE]

## 🔴 Immediate Action Required
(blocking items with owners and deadlines if determinable)

## 🟡 This Week
(non-urgent important items)

## ℹ️ FYI
(informational, no action needed)

## Metrics
(any numbers worth tracking)

Keep it scannable. Use bullet points. Replace [DATE] with "Today".`,
        maxTokens: 1024,
        dependsOn: ["ct-007-a"],
      },
    ],
    synthesisPromptTemplate: `Combine the extraction and briefing into a final document.

## Key Points Extraction
{{CT_007_A_OUTPUT}}

## Daily Briefing
{{CT_007_B_OUTPUT}}

Return the final briefing document only (the output of the briefing step). Do not include the extraction analysis in the final output — it was an intermediate step. Clean up any awkward formatting.`,
    synthesisSystemPrompt:
      "You are assembling a daily briefing. Return only the polished final briefing document.",
    synthesisMaxTokens: 1536,
  },
];
