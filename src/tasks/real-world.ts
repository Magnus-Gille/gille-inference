import type { TaskDefinition } from '../types.js';

// Every person, organization, address, and commercial detail in this file is synthetic test data.

export const REAL_WORLD_TASKS: TaskDefinition[] = [
  // ---------------------------------------------------------------------------
  // real-001: Session Status Report
  // ---------------------------------------------------------------------------
  {
    id: 'real-001',
    category: 'non-coding',
    title: 'Session Status Report',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['status', 'planning', 'project-management'],
    prompt: `Here is a project's STATUS.md file and recent git log. Summarize: where are we, what's done, what's left, and what should I work on next?

STATUS.md:
\`\`\`
# Heimdall Dashboard
## Phase: Beta
- [x] Authentication module
- [x] Device discovery (mDNS)
- [x] Basic dashboard layout
- [ ] Real-time metrics (CPU, memory, disk)
- [ ] Alert system
- [ ] Mobile responsive
- [ ] Docker deployment

## Blockers
- Tailscale DNS resolution flaky on Pi
- Need to decide: WebSocket vs SSE for real-time updates

## Last session
- Fixed mDNS timeout bug
- Started metrics collector but didn't finish
\`\`\`

Recent git log:
\`\`\`
3h ago  fix: mDNS discovery timeout increased to 5s
3h ago  feat: add system metrics types
1d ago  feat: basic dashboard grid layout
2d ago  fix: auth token refresh loop
3d ago  feat: device discovery via mDNS
\`\`\`

Give me a concise status report and prioritized next steps.`,
    expectedCapabilities: [
      'identifies current phase correctly',
      'summarizes done vs remaining',
      'acknowledges blockers',
      'suggests prioritized next steps',
      'concise but complete',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-002: Debug from Error Paste
  // ---------------------------------------------------------------------------
  {
    id: 'real-002',
    category: 'debugging',
    title: 'Debug from Error Paste',
    difficulty: 2,
    maxTokens: 1500,
    tags: ['debugging', 'sqlite', 'mcp', 'error-paste'],
    prompt: `I get this error when running my MCP server:

\`\`\`
Error: SQLITE_BUSY: database is locked
    at Database.exec (/home/pi/munin-memory/node_modules/better-sqlite3/lib/methods/exec.js:4:14)
    at initDb (/home/pi/munin-memory/src/db.ts:45:6)
    at Object.<anonymous> (/home/pi/munin-memory/src/index.ts:12:1)
\`\`\`

The server was working fine before. I restarted it after a crash. What's wrong and how do I fix it?`,
    expectedCapabilities: [
      'identifies SQLite lock issue',
      'explains WAL mode or journal file',
      'suggests checking for zombie processes',
      'provides concrete fix commands',
      'explains prevention',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-003: Git Commit Message
  // ---------------------------------------------------------------------------
  {
    id: 'real-003',
    category: 'non-coding',
    title: 'Git Commit Message',
    difficulty: 1,
    maxTokens: 500,
    tags: ['git', 'commit-message'],
    prompt: `Write a commit message for these changes. Follow conventional commit style.

\`\`\`diff
--- a/src/tools.ts
+++ b/src/tools.ts
@@ -45,6 +45,15 @@ export function registerTools(server: McpServer) {
+  server.tool('memory_query', {
+    query: z.string().describe('Search query'),
+    tags: z.array(z.string()).optional(),
+    namespace: z.string().optional(),
+    limit: z.number().default(10),
+  }, async (params) => {
+    const results = await db.query(params);
+    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
+  });

--- a/src/db.ts
+++ b/src/db.ts
@@ -112,0 +113,25 @@
+export function query(params: QueryParams): QueryResult[] {
+  const stmt = db.prepare(\`
+    SELECT * FROM memories
+    WHERE content MATCH @query
+    \${params.namespace ? 'AND namespace = @namespace' : ''}
+    \${params.tags ? 'AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (SELECT value FROM json_each(@tags)))' : ''}
+    ORDER BY rank
+    LIMIT @limit
+  \`);
+  return stmt.all(params) as QueryResult[];
+}
\`\`\``,
    expectedCapabilities: [
      'conventional commit format',
      'identifies this is a feature addition',
      'mentions both the tool registration and db query',
      'concise subject line under 72 chars',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-004: Refactor Express Route
  // ---------------------------------------------------------------------------
  {
    id: 'real-004',
    category: 'refactoring',
    title: 'Refactor Express Route',
    difficulty: 2,
    maxTokens: 2000,
    tags: ['refactoring', 'fortnox', 'typescript', 'express'],
    prompt: `Refactor this Fortnox API route handler. It works but is messy — nested callbacks, no types, poor error handling:

\`\`\`typescript
app.get('/api/invoices/:id', (req, res) => {
  const token = req.headers['authorization'];
  if (!token) { res.status(401).send('no auth'); return; }
  fetch('https://api.fortnox.se/3/invoices/' + req.params.id, {
    headers: { 'Authorization': 'Bearer ' + token.replace('Bearer ', ''), 'Content-Type': 'application/json' }
  }).then(r => {
    if (r.status === 401) { res.status(401).send('bad token'); return; }
    if (r.status === 404) { res.status(404).send('not found'); return; }
    return r.json();
  }).then(data => {
    if (data && data.Invoice) {
      const inv = data.Invoice;
      res.json({
        number: inv.DocumentNumber,
        customer: inv.CustomerName,
        total: inv.Total,
        balance: inv.Balance,
        due: inv.DueDate,
        paid: inv.Balance === 0
      });
    } else {
      res.status(500).send('weird response');
    }
  }).catch(e => { console.log(e); res.status(500).send('error'); });
});
\`\`\``,
    expectedCapabilities: [
      'async/await conversion',
      'proper TypeScript types for request/response',
      'structured error handling',
      'extracts auth logic',
      'proper HTTP status codes',
      'type-safe Fortnox response mapping',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-005: Swedish Email Extraction
  // ---------------------------------------------------------------------------
  {
    id: 'real-005',
    category: 'non-coding',
    title: 'Swedish Email Extraction',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['swedish', 'email', 'extraction', 'structured-output'],
    prompt: `Extract all actionable items from this Swedish email thread. Output as a structured JSON list with fields: action, owner, deadline, priority.

Today's date is 2026-03-27 (Thursday).

Email thread:
\`\`\`
Från: Jordan Example <jordan@example.com>
Till: Morgan Example
Datum: 2026-03-27
Ämne: Re: Uppföljning Q1 fakturering

Hej Morgan,

Tack för uppdateringen. Några saker vi behöver ta tag i:

1. Faktura #2024-031 till Example Export Customer behöver korrigeras - fel momssats (25% istället för 0% för export). Kan du fixa det innan fredag?

2. Vi saknar fortfarande timrapporter från Alex för februari. Kan du påminna honom? Deadline 5 april.

3. Jag har pratat med Casey om det nya avtalet med Example Partner. Hon vill ha ett utkast till tisdag. Prio hög.

4. Löpande: vi behöver gå igenom alla utestående fakturor äldre än 60 dagar. Boka in ett möte nästa vecka?

Mvh,
Jordan
\`\`\``,
    expectedCapabilities: [
      'correct Swedish comprehension',
      'extracts all 4 action items',
      'assigns correct owners',
      'converts relative dates to concrete dates',
      'appropriate priority levels',
      'valid JSON output',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-006: Documentation Write-up
  // ---------------------------------------------------------------------------
  {
    id: 'real-006',
    category: 'non-coding',
    title: 'Documentation Write-up',
    difficulty: 3,
    maxTokens: 2000,
    tags: ['documentation', 'readme', 'oauth', 'mcp'],
    prompt: `I just finished implementing OAuth support for the munin-memory MCP server. Write a section for the README explaining how to set it up. Keep it concise but cover:

- What OAuth is used for (authenticating remote clients — Claude Desktop, mobile, web)
- The environment variables needed (OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI)
- How to register a new OAuth client
- The authentication flow (browser redirect → callback → token)
- Example .env configuration

Target audience: developers who know what OAuth is but haven't used it with MCP before.`,
    expectedCapabilities: [
      'appropriate markdown formatting',
      'covers all 5 points',
      'correct OAuth flow description',
      'realistic .env example',
      'concise but complete',
      'appropriate tone for developer docs',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-007: Multi-turn Debugging
  // ---------------------------------------------------------------------------
  {
    id: 'real-007',
    category: 'debugging',
    title: 'Multi-turn Debugging',
    difficulty: 3,
    maxTokens: 2000,
    tags: ['debugging', 'astro', 'cloudflare', 'deployment'],
    prompt: `My Astro site builds fine locally but deployment to Cloudflare Pages fails. Here's the build log:

\`\`\`
[build] 14:23:01 Building...
[build] 14:23:03 src/pages/index.astro
[build] 14:23:03 src/pages/about.astro
[build] 14:23:04 src/pages/blog/[...slug].astro
[error] 14:23:04 Unable to render component BlogPost
[error] 14:23:04 Error: Cannot find module './components/BlogPost.astro'
[error] 14:23:04   at resolve (/opt/buildhome/repo/node_modules/astro/dist/core/build/resolve.js:42:11)
[build] 14:23:04 Build failed in 3.12s
\`\`\`

The file exists at \`src/components/BlogPost.astro\` and works locally on macOS. Why does it fail on Cloudflare (Linux)?`,
    expectedCapabilities: [
      'identifies case-sensitivity issue (macOS case-insensitive, Linux case-sensitive)',
      'asks about actual filename casing or suggests checking with ls',
      'provides fix (rename file or fix import)',
      'explains the macOS vs Linux filesystem difference',
      'suggests prevention (.gitattributes or lint rule)',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-008: Slide Content Generation
  // ---------------------------------------------------------------------------
  {
    id: 'real-008',
    category: 'non-coding',
    title: 'Slide Content Generation',
    difficulty: 2,
    maxTokens: 800,
    tags: ['swedish', 'presentation', 'slides', 'non-technical'],
    prompt: `Generate bullet points for a presentation slide about local LLM inference for a non-technical audience. The slide title is 'Varför köra AI lokalt?' (Why run AI locally?). I need:

- 4-5 bullet points in Swedish
- Each point should be short (max 10 words)
- Cover: privacy, cost savings, availability, speed, independence
- Tone: professional but accessible, not too techy
- Include one relevant emoji per point`,
    expectedCapabilities: [
      'correct Swedish',
      'exactly 4-5 points',
      'under 10 words each',
      'covers all requested themes',
      'appropriate emojis',
      'accessible tone',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-009: MCP Tool Skeleton
  // ---------------------------------------------------------------------------
  {
    id: 'real-009',
    category: 'multi-file',
    title: 'MCP Tool Skeleton',
    difficulty: 4,
    maxTokens: 4000,
    tags: ['mcp', 'fortnox', 'multi-file', 'typescript'],
    prompt: `Generate a complete MCP tool implementation for a 'fortnox_create_invoice' tool. The tool should:

1. Accept: customer_number (string), rows (array of {article_number, quantity, unit_price}), due_days (number, default 30)
2. Validate input with zod schemas
3. Call the Fortnox API (POST /3/invoices/) with proper auth headers
4. Return the created invoice number and total amount
5. Handle errors (auth failure, validation error, API error)

Generate these files:
- types.ts (interfaces for invoice request/response)
- schema.ts (zod validation)
- handler.ts (the actual tool logic)
- register.ts (MCP tool registration)

Use TypeScript with @modelcontextprotocol/sdk. Here is the MCP tool registration pattern to follow:

\`\`\`typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

server.tool('tool_name', {
  param1: z.string().describe('Description'),
  param2: z.number().default(10),
}, async (params) => {
  // implementation
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
\`\`\`

The Fortnox API expects this invoice body format:
\`\`\`json
{
  "Invoice": {
    "CustomerNumber": "123",
    "DueDate": "2026-04-30",
    "InvoiceRows": [
      { "ArticleNumber": "PROD1", "DeliveredQuantity": 2, "Price": 500 }
    ]
  }
}
\`\`\`
Auth: Bearer token via Authorization header.`,
    expectedCapabilities: [
      'correct MCP tool registration pattern',
      'zod schemas match the input spec',
      'proper Fortnox API request format',
      'comprehensive error handling',
      'correct TypeScript types',
      'multi-file organization',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-010: Research and Fact-Check
  // ---------------------------------------------------------------------------
  {
    id: 'real-010',
    category: 'non-coding',
    title: 'Research and Fact-Check',
    difficulty: 3,
    maxTokens: 2500,
    tags: ['fact-check', 'research', 'apple-silicon', 'llm'],
    prompt: `I'm writing a blog post about running local LLMs on Apple Silicon. Fact-check and correct these claims:

1. 'The M4 Max has 546 GB/s memory bandwidth, making it faster than an RTX 4090 for LLM inference'
2. 'A 70B parameter model needs at least 140GB of RAM at FP16'
3. 'MoE models like Qwen3-235B only use 22B parameters per token, so they run as fast as a 22B dense model'
4. 'MLX is always faster than llama.cpp on Apple Silicon'
5. 'Running models locally is always cheaper than API access'

For each claim: state if it's true, false, or misleading, explain why, and provide the correct information. Use your knowledge — no web search needed. Answers like "misleading because..." or "true but with caveats..." are preferred over simple true/false.

Key facts for reference:
- M4 Max memory bandwidth: 546 GB/s
- RTX 4090 memory bandwidth: 1,008 GB/s (but only 24GB VRAM)
- RTX 4090 VRAM: 24 GB GDDR6X`,
    expectedCapabilities: [
      'correctly evaluates each claim',
      'identifies claim 1 as misleading (4090 has higher bandwidth but less memory)',
      'correctly calculates 70B at FP16 = ~140GB (true)',
      'explains MoE bandwidth vs compute nuance for claim 3',
      'identifies claim 4 as generally true but with caveats',
      'identifies claim 5 as false (depends on volume)',
      'provides reasoning for each verdict',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-011: LLM Hardware Fit Reasoning
  // ---------------------------------------------------------------------------
  {
    id: 'real-011',
    category: 'non-coding',
    title: 'LLM Hardware Fit Reasoning',
    difficulty: 4,
    maxTokens: 2500,
    tags: ['research', 'apple-silicon', 'llm', 'hardware', 'quantization'],
    prompt: `I have a Mac Studio with M4 Max and 128 GB unified memory (546 GB/s bandwidth). I want to run local models for coding assistance via Ollama. Evaluate these three models:

1. **Qwen3-32B** (32B params, dense)
2. **Llama3.3-70B** (70B params, dense)
3. **GPT-oss-120B** (120B params, dense)

For each model, tell me:
- Memory needed at FP16 vs Q4_K_M vs Q2_K quantization
- Whether it fits in 128 GB at each quantization level (yes/no with headroom estimate)
- Expected tokens/sec range for interactive use (assume Ollama + MLX backend)
- Quality tradeoff at each quantization level (is Q4 good enough for code? what about Q2?)

Then recommend: which model + quantization gives the best quality-per-GB for coding tasks specifically? And at what point should I just use a cloud API instead?`,
    expectedCapabilities: [
      'correct memory calculation (params × bytes-per-weight + KV cache overhead)',
      'knows FP16 = 2 bytes, Q4 ≈ 0.5 bytes, Q2 ≈ 0.3 bytes per param',
      'accounts for KV cache and runtime overhead (not just weight size)',
      'realistic tok/s estimates for Apple Silicon',
      'understands Q4 quality is near-FP16 for most tasks',
      'warns about Q2 quality degradation for complex reasoning',
      'provides a clear recommendation with reasoning',
      'acknowledges cloud API strengths for long-context / frontier tasks',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-012: Rich Session Continuity
  // ---------------------------------------------------------------------------
  {
    id: 'real-012',
    category: 'non-coding',
    title: 'Rich Session Continuity',
    difficulty: 4,
    maxTokens: 2000,
    tags: ['status', 'planning', 'multi-project', 'synthesis'],
    prompt: `I just came back to my desk. Here's the state of things — tell me what's done, what failed, what needs attention, and what I should work on next.

**Background tasks completed while I was away:**
- ✅ Hugin task "stale-status-review" completed (2h ago). Output: "3 of 6 project statuses are stale (>14 days). Heimdall, Mimir, and Ratatoskr need updates."
- ✅ Benchmark run finished (3h ago). Results: Qwen3-14B scored 1.48/2.0, GLM4 scored 1.31/2.0, 4 tasks timed out.
- ❌ Deploy task "skuld-update" failed (1h ago). Error: "npm run build exited with code 1 — TypeScript error in src/collectors/commercial.ts:45 — Property 'staleness' does not exist on type 'BusinessEntry'"

**TODO list (started yesterday):**
1. ✅ Fix Munin session ID fragmentation
2. ✅ Deploy session fix to Pi
3. ⬜ Write blog post about Norse Stack architecture
4. ⬜ Run second prompt-mining pass for eval tasks
5. ⬜ Prepare slides for Thursday Example Partner workshop
6. ⬜ Review Codex critique of multi-principal auth spec
7. ⬜ Update energy monitor with cache invalidation detection
8. ⬜ Invoice Cody Consulting for March

**Recent git log (grimnir repo):**
\`\`\`
35m ago  fix: send stable mcp-session-id header to Munin
2h ago   chore: update STATUS.md with afternoon session
5h ago   chore: update STATUS.md with full March 31 session
\`\`\`

Synthesize this into a concise status report with prioritized next steps. Flag anything that needs immediate attention.`,
    expectedCapabilities: [
      'identifies the failed deploy as needing immediate attention',
      'correctly synthesizes completed background tasks',
      'recognizes the TypeScript error is actionable (suggests fix)',
      'prioritizes Thursday workshop prep by urgency',
      'groups TODO items by urgency/dependency',
      'notes the benchmark results without over-interpreting',
      'concise but covers all 3 state sources',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-013: Systemd Service + Timer Creation
  // ---------------------------------------------------------------------------
  {
    id: 'real-013',
    category: 'simple-coding',
    title: 'Systemd Service + Timer Creation',
    difficulty: 2,
    maxTokens: 1500,
    tags: ['systemd', 'linux', 'deployment', 'pi'],
    prompt: `Create a systemd service and timer to run a daily journal analysis script on my Raspberry Pi.

Requirements:
- Script: \`/srv/hugin/scripts/submit-daily-analysis.sh\`
- Schedule: every day at 07:00 local time (Europe/Stockholm)
- The script needs these env vars: \`MUNIN_URL=http://localhost:3030\` and \`MUNIN_API_KEY\` (read from \`/etc/hugin/runtime.env\`)
- Run as user \`hugin\`
- Log to journal with tag \`daily-analysis\`
- Don't restart on failure (it's a one-shot)

Generate:
1. The .service unit file
2. The .timer unit file
3. The shell commands to install and enable them`,
    expectedCapabilities: [
      'correct systemd unit file syntax',
      'Type=oneshot for one-shot scripts',
      'EnvironmentFile directive for .env loading',
      'OnCalendar with timezone handling',
      'Persistent=true so missed runs fire on boot',
      'correct install commands (systemctl daemon-reload, enable --now)',
      'SyslogIdentifier for journal tagging',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-014: Business Model Reasoning
  // ---------------------------------------------------------------------------
  {
    id: 'real-014',
    category: 'non-coding',
    title: 'Business Model Reasoning',
    difficulty: 4,
    maxTokens: 2500,
    tags: ['business', 'strategy', 'productization', 'open-source'],
    prompt: `I built an open-source personal memory server (like a second brain for AI assistants). It runs on a Raspberry Pi, stores everything locally, and syncs across devices. ~50 GitHub stars, I use it daily.

I'm considering selling pre-installed hardware kits: a Raspberry Pi Zero 2 W (€15 cost) with the software pre-configured, in a nice case with an SD card. Pricing ideas:
- Option A: €29/year subscription (includes updates + cloud backup)
- Option B: €79 one-time (self-hosted, community updates only)
- Option C: Both tiers available

Questions:
1. What am I actually selling — the hardware, the software, the setup convenience, or the ongoing service?
2. Is the cost structure viable at small scale (5-10 units initially)?
3. What are the biggest risks?
4. The software is MIT licensed. Does that create a problem?
5. What would you do differently?

Be direct — I want honest analysis, not encouragement.`,
    expectedCapabilities: [
      'identifies convenience + curation as the core value prop (not raw software)',
      'calculates realistic unit economics (BOM + shipping + support time)',
      'warns about support cost at subscription price point',
      'addresses MIT license risk (competitors can fork + sell)',
      'suggests alternative models (e.g., managed hosting, premium features)',
      'honest about scale challenges (small HW margins, support burden)',
      'structured analysis, not just cheerleading',
    ],
  },

  // ---------------------------------------------------------------------------
  // real-015: Benchmark Result Interpretation
  // ---------------------------------------------------------------------------
  {
    id: 'real-015',
    category: 'non-coding',
    title: 'Benchmark Result Interpretation',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['benchmark', 'analysis', 'llm', 'inference'],
    prompt: `Here are my local LLM benchmark results. Interpret them and recommend which setup to use.

| Model | Backend | Prefill (tok/s) | Decode (tok/s) | Quality (0-2) | RAM Used |
|-------|---------|-----------------|----------------|---------------|----------|
| Qwen3-14B Q4 | llama.cpp Metal | 487 | 42 | 1.48 | 9.2 GB |
| Qwen3-14B Q4 | Ollama+MLX | 812 | 78 | 1.48 | 9.1 GB |
| Llama3.3-70B Q4 | llama.cpp Metal | 124 | 11 | 1.72 | 42 GB |
| Llama3.3-70B Q4 | Ollama+MLX | 203 | 19 | 1.72 | 41 GB |
| GLM4-9B Q8 | llama.cpp Metal | 623 | 51 | 1.31 | 10.4 GB |
| GLM4-9B Q8 | Ollama+MLX | 1,041 | 94 | 1.31 | 10.2 GB |

Hardware: Example laptop with 32 GB unified memory. Use cases: coding assistance, email drafting, document summarization.

Questions:
1. Which backend wins and by how much? Is the difference meaningful for interactive use?
2. Which model gives the best quality-per-GB?
3. Can I run two models concurrently on 32 GB? Which pair?
4. At what decode speed does interactive use become frustrating?`,
    expectedCapabilities: [
      'correctly identifies MLX as 1.6-1.8x faster across the board',
      'explains that >30 tok/s decode feels interactive, <15 feels sluggish',
      'calculates quality/GB ratio (Qwen3 = 1.48/9.1 = 0.16, Llama = 1.72/42 = 0.04)',
      'recommends Qwen3 as best quality-per-GB',
      'correctly evaluates concurrent fit (Qwen3 + GLM4 ≈ 19 GB, fits with headroom)',
      'warns that 70B at 19 tok/s is borderline for interactive coding',
      'provides a clear recommendation',
    ],
  },
];
