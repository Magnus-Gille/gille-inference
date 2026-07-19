import type { TaskDefinition } from '../types.js';

// Every person, organization, address, and commercial detail in this file is synthetic test data.

// ─── Grimnir Infrastructure Tasks ───────────────────────────────────────────
//
// These tasks mirror real workloads that local models would handle in the
// Grimnir architecture. They test whether "good enough" models can replace
// frontier models for delegated worker tasks.
//
// Categories:
//   briefing    — Skuld-style daily briefing generation from structured data
//   memory      — Munin-style query synthesis, summarization, context retrieval
//   triage      — Code review triage: decide if something needs human/Claude review
//   structured  — Structured output generation (JSON, YAML, markdown templates)
//   chat        — Conversational utility (quick answers, formatting, translation)
//   routing     — Ratatoskr-style intent classification and request routing

export const GRIMNIR_TASKS: TaskDefinition[] = [
  // ---------------------------------------------------------------------------
  // briefing-001: Daily intelligence briefing from structured data
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-briefing-001',
    category: 'non-coding',
    title: 'Daily briefing from calendar + tasks + news',
    difficulty: 3,
    maxTokens: 2000,
    tags: ['skuld', 'briefing', 'structured-generation', 'grimnir'],
    prompt: `You are generating a daily intelligence briefing for a software consultant. Write a concise morning briefing from this data.

Calendar today:
- 09:00-09:30 Standup with Example Corp (synthetic) (remote)
- 11:00-12:00 Architecture review — auth service migration
- 14:00-15:00 1:1 with Taylor (team lead)
- 16:30 Dentist

Tasks (from project tracker):
- [URGENT] Fix production memory leak in API gateway (assigned yesterday)
- [IN PROGRESS] Auth service migration — Phase 2 (60% complete, deadline Friday)
- [BLOCKED] Dashboard redesign — waiting on design review from Taylor
- [TODO] Write Q2 capacity plan (due next Monday)

Weather: Stockholm, 8°C, cloudy, chance of rain afternoon.

Commercial pipeline:
- Example Corp (synthetic): Current engagement, 3 months remaining. Expansion discussion ongoing.
- Example Nordic (synthetic): Proposal sent last week (180k SEK), awaiting response.
- Internal: Munin Memory productization — early exploration phase.

Write the briefing in this format:
## Good morning
[1-2 sentence overview of the day]

## Today's Focus
[Top 2-3 priorities with brief rationale]

## Schedule
[Timeline with prep notes where relevant]

## Radar
[2-3 things to keep in mind but not act on today]`,
    expectedCapabilities: [
      'follows the exact template structure',
      'correctly prioritizes the production memory leak as urgent',
      'notes the Friday deadline for auth migration',
      'connects the 1:1 with Taylor to the blocked dashboard task',
      'mentions the Example Nordic (synthetic) proposal in radar',
      'tone is concise and actionable, not verbose',
    ],
  },

  // ---------------------------------------------------------------------------
  // briefing-002: Commercial pulse section from business data
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-briefing-002',
    category: 'non-coding',
    title: 'Commercial pulse from Munin business data',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['skuld', 'fé', 'commercial', 'grimnir'],
    prompt: `Generate a "Commercial Pulse" section for a daily briefing. You have these business items from Munin memory:

Item 1 — VIP AI Coaching:
- Status: Active pilot
- Revenue: 15,000 SEK/month (2 clients)
- Pipeline: 3 warm leads from conference last week
- Next action: Send follow-up proposals by Wednesday
- Risk: One current client hinting at budget cuts in Q3

Item 2 — Munin Memory (product):
- Status: Early exploration
- Revenue: None (pre-revenue)
- Next milestone: MVP feature set defined
- Opportunity: 2 potential beta testers expressed interest via Twitter DMs
- Blocker: No landing page yet

Item 3 — Consulting (Example Corp (synthetic)):
- Status: Active engagement
- Revenue: 95,000 SEK/month
- Remaining: 3 months on current SOW
- Expansion: Discussing 6-month extension + 2 additional team members
- Risk: Their CTO leaving end of April — new CTO may re-evaluate vendors

Write 3-5 bullet points. Each should be one sentence, lead with what matters, flag risks. End with a one-line "Bottom line" summary.`,
    expectedCapabilities: [
      'leads with the most financially significant item (Example Corp (synthetic))',
      'flags the CTO departure risk prominently',
      'notes the Wednesday deadline for coaching proposals',
      'keeps bullets to single sentences',
      'bottom line captures the overall picture accurately',
    ],
  },

  // ---------------------------------------------------------------------------
  // memory-001: Synthesize context from multiple memory entries
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-memory-001',
    category: 'non-coding',
    title: 'Synthesize project context from memory entries',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['munin', 'memory', 'synthesis', 'grimnir'],
    prompt: `You are a memory-augmented assistant. The user asks: "What's the status on the auth migration?"

Here are relevant entries retrieved from memory:

Entry 1 (projects/heimdall/status, updated 2 days ago):
"Phase: Auth migration Phase 2. Middleware rewrite 60% complete. Blocked on session token format decision. Taylor reviewing the compliance requirements."

Entry 2 (decisions/auth-token-format, logged 5 days ago):
"Decision: Use opaque reference tokens instead of JWTs for session management. Rationale: legal flagged JWT payload as storing PII in a way that doesn't meet new GDPR requirements. Opaque tokens keep PII server-side only."

Entry 3 (projects/heimdall/status, updated 8 days ago):
"Phase: Auth migration Phase 1 complete. Old middleware removed from 3/4 services. Payment service still on legacy auth — needs careful migration due to PCI scope."

Entry 4 (people/lisa, updated 3 days ago):
"Taylor is reviewing the token format decision for compliance sign-off. She mentioned Thursday as her target for feedback."

Synthesize these into a coherent status update. Be specific about what's done, what's in progress, what's blocked, and what's next. Don't just list the entries — connect the dots.`,
    expectedCapabilities: [
      'connects the token format decision to the GDPR rationale',
      'identifies Taylor as the blocker and notes Thursday target',
      'mentions Phase 1 completion and the payment service caveat',
      'presents a coherent narrative, not just a list of entries',
      'notes the 60% completion on Phase 2',
    ],
  },

  // ---------------------------------------------------------------------------
  // memory-002: Answer a question requiring cross-namespace reasoning
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-memory-002',
    category: 'non-coding',
    title: 'Cross-namespace memory query',
    difficulty: 4,
    maxTokens: 1000,
    tags: ['munin', 'memory', 'reasoning', 'grimnir'],
    prompt: `You are a memory-augmented assistant. The user asks: "Should I bring up the Munin pricing with the beta testers this week?"

Relevant memory entries:

Entry 1 (business/munin-memory, updated 1 day ago):
"Munin Memory product. Pre-revenue. 2 beta testers interested (from Twitter DMs). No landing page. MVP feature set not yet defined."

Entry 2 (decisions/pricing-philosophy, logged 2 weeks ago):
"Decision: Don't discuss pricing until MVP feature set is locked and at least 3 users have tried it. Rationale: Pricing too early anchors expectations and limits pivoting. Morgan learned this from the coaching product — early pricing committed him to a scope he later wanted to change."

Entry 3 (people/morgan/preferences, updated 1 month ago):
"Morgan prefers to validate product-market fit before monetization. Quotes: 'I'd rather have 10 users who love it for free than 2 who pay and expect support.'"

Entry 4 (projects/munin-memory/status, updated 3 days ago):
"Current focus: multi-principal authorization matrix. Not yet at MVP — core features still being built."

Give a clear recommendation with reasoning. Reference the relevant context.`,
    expectedCapabilities: [
      'recommends NO — do not discuss pricing yet',
      'cites the pricing-philosophy decision as primary reason',
      'notes MVP is not ready (authz matrix still in progress)',
      'references Morgan preference for validation before monetization',
      'gives a concrete alternative (what to do with beta testers instead)',
    ],
  },

  // ---------------------------------------------------------------------------
  // triage-001: Code review triage — escalate or not?
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-triage-001',
    category: 'non-coding',
    title: 'Code review triage — security-relevant change',
    difficulty: 3,
    maxTokens: 1000,
    tags: ['triage', 'code-review', 'security', 'grimnir'],
    prompt: `You are a code review triage assistant. Your job is to classify pull requests as:
- APPROVE: Safe to merge, no concerns
- COMMENT: Minor issues, leave suggestions but don't block
- ESCALATE: Needs human or frontier model review

Here is a PR diff:

Title: "Fix session expiry check"
Author: bot/dependabot
Files changed: src/auth/session.ts

\`\`\`diff
@@ -42,7 +42,7 @@ export function isSessionValid(session: Session): boolean {
-  return session.expiresAt > Date.now();
+  return session.expiresAt >= Date.now();
 }

@@ -58,3 +58,12 @@ export function refreshSession(session: Session): Session {
+export function createSession(userId: string, ttlMs: number = 86400000): Session {
+  return {
+    id: crypto.randomUUID(),
+    userId,
+    createdAt: Date.now(),
+    expiresAt: Date.now() + ttlMs,
+    permissions: getUserPermissions(userId),
+  };
+}
\`\`\`

Classify this PR and explain your reasoning in 2-3 sentences.`,
    expectedCapabilities: [
      'classifies as ESCALATE (not APPROVE)',
      'identifies that a new session creation function was added — scope beyond a "fix"',
      'notes the security relevance: auth/session code with permission assignment',
      'flags that the author is dependabot but the change looks like feature code',
      'reasoning is concise and specific',
    ],
  },

  // ---------------------------------------------------------------------------
  // triage-002: Code review triage — routine dependency update
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-triage-002',
    category: 'non-coding',
    title: 'Code review triage — dependency bump',
    difficulty: 2,
    maxTokens: 800,
    tags: ['triage', 'code-review', 'grimnir'],
    prompt: `You are a code review triage assistant. Classify as APPROVE, COMMENT, or ESCALATE.

Title: "chore(deps): bump vitest from 3.0.4 to 3.0.5"
Author: bot/dependabot
Files changed: package.json, package-lock.json

\`\`\`diff
--- a/package.json
+++ b/package.json
@@ -15,7 +15,7 @@
   "devDependencies": {
-    "vitest": "^3.0.4",
+    "vitest": "^3.0.5",
     "typescript": "^5.7.0",
\`\`\`

package-lock.json: [large lockfile diff omitted — only vitest and its sub-dependencies changed]

CI status: All checks passing.

Classify and explain in 1-2 sentences.`,
    expectedCapabilities: [
      'classifies as APPROVE',
      'notes it is a patch version bump of a dev dependency',
      'mentions CI passing as supporting evidence',
      'keeps explanation brief',
    ],
  },

  // ---------------------------------------------------------------------------
  // structured-001: Generate structured JSON from natural language
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-structured-001',
    category: 'non-coding',
    title: 'Extract structured data from meeting notes',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['structured', 'json', 'extraction', 'grimnir'],
    prompt: `Extract structured data from these meeting notes. Return valid JSON only, no explanation.

Meeting notes:
"Had a call with Alex from Example Nordic (synthetic) about the proposal. He likes the scope but thinks 180k is too high — asked if we could do it for 150k by cutting the performance audit phase. I said I'd think about it. He needs an answer by Friday. Also mentioned they're evaluating one other vendor (didn't say who). Their timeline is to kick off mid-April. Alex's direct line is +1-202-555-0100."

Required JSON schema:
{
  "company": string,
  "contact": { "name": string, "phone": string },
  "proposal_amount_sek": number,
  "counter_offer_sek": number,
  "cut_scope": string,
  "deadline": string,
  "competition": string,
  "kickoff_target": string,
  "next_action": string
}`,
    expectedCapabilities: [
      'returns valid JSON (parseable)',
      'extracts all fields correctly',
      'proposal_amount is 180000, counter_offer is 150000',
      'identifies the cut scope as performance audit',
      'next_action captures the need to respond by Friday',
      'does not add extra commentary outside the JSON',
    ],
  },

  // ---------------------------------------------------------------------------
  // structured-002: Generate a Munin-compatible memory entry
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-structured-002',
    category: 'non-coding',
    title: 'Generate a memory write from conversation context',
    difficulty: 3,
    maxTokens: 1000,
    tags: ['munin', 'structured', 'memory-write', 'grimnir'],
    prompt: `Based on this conversation excerpt, generate a Munin memory write command.

Conversation:
User: "We decided to go with SQLite + FTS5 for Munin's search backend instead of the shodh-memory library."
Assistant: "What drove that decision?"
User: "Three things: shodh-memory only has 7 GitHub stars and a single maintainer — too risky. It doesn't have ARM64 builds for the Pi. And SQLite is already a dependency so it's zero added complexity. The FTS5 full-text search is good enough for our query patterns."

Generate the memory_write call as JSON:
{
  "namespace": string (use decisions/<topic> format),
  "key": string,
  "content": string (the decision + rationale, written for future reference),
  "tags": string[]
}

The content should be written so that someone reading it 6 months from now understands both WHAT was decided and WHY.`,
    expectedCapabilities: [
      'namespace follows decisions/<topic> pattern',
      'content captures the decision clearly (SQLite+FTS5 over shodh-memory)',
      'content includes all three rationale points',
      'content is written for future readers, not just echoing the conversation',
      'tags are relevant and reusable',
      'returns valid JSON',
    ],
  },

  // ---------------------------------------------------------------------------
  // routing-001: Intent classification for chat routing
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-routing-001',
    category: 'non-coding',
    title: 'Classify user intent for request routing',
    difficulty: 2,
    maxTokens: 500,
    tags: ['ratatoskr', 'routing', 'classification', 'grimnir'],
    prompt: `You are a request router. Classify each user message into exactly one category and confidence level (high/medium/low). Categories:
- CALENDAR: Schedule queries, availability, meeting management
- EMAIL: Email composition, search, inbox management
- MEMORY: Recall past decisions, project status, people info
- CODE: Code generation, review, debugging
- SEARCH: Web search, research, fact-finding
- CHAT: General conversation, opinions, brainstorming
- TASK: Task creation, status updates, project management

Classify these messages (return as JSON array):

1. "What did we decide about the auth token format?"
2. "Am I free Thursday afternoon?"
3. "Write me a Python script to parse CSV files"
4. "What's the weather in Stockholm?"
5. "Remind me to follow up with Alex on Friday"
6. "How's the Heimdall project going?"
7. "Draft a reply to Taylor's email about the design review"
8. "What are the pros and cons of SQLite vs Postgres for this use case?"`,
    expectedCapabilities: [
      'message 1 → MEMORY (high)',
      'message 2 → CALENDAR (high)',
      'message 3 → CODE (high)',
      'message 4 → SEARCH (high)',
      'message 5 → TASK (high)',
      'message 6 → MEMORY (high)',
      'message 7 → EMAIL (high)',
      'message 8 → CHAT or SEARCH (medium) — ambiguous is OK',
      'returns valid JSON',
    ],
  },

  // ---------------------------------------------------------------------------
  // routing-002: Complex multi-intent message
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-routing-002',
    category: 'non-coding',
    title: 'Handle multi-intent user message',
    difficulty: 4,
    maxTokens: 800,
    tags: ['ratatoskr', 'routing', 'multi-intent', 'grimnir'],
    prompt: `You are a request router. Some messages contain multiple intents. For each, identify the intents, their categories, and suggest how to decompose the request.

Categories: CALENDAR, EMAIL, MEMORY, CODE, SEARCH, CHAT, TASK

Message: "Check if I'm free tomorrow at 2pm, and if so, draft an email to Alex at Example Nordic (synthetic) suggesting we meet then to discuss the proposal. Also remind me to review the auth migration PR before the meeting."

Return JSON:
{
  "intents": [
    { "text": "...", "category": "...", "depends_on": null | intent_index },
    ...
  ],
  "execution_order": "parallel" | "sequential" | "mixed",
  "reasoning": "..."
}`,
    expectedCapabilities: [
      'identifies 3 intents: calendar check, email draft, task/reminder',
      'correctly marks the email as depending on the calendar check result',
      'the reminder is independent (parallel with the others)',
      'execution_order is "mixed" or "sequential" (not "parallel")',
      'reasoning explains the dependency chain',
    ],
  },

  // ---------------------------------------------------------------------------
  // chat-001: Quick utility — Swedish business email
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-chat-001',
    category: 'non-coding',
    title: 'Draft a short Swedish business email',
    difficulty: 2,
    maxTokens: 800,
    tags: ['chat', 'utility', 'swedish', 'email', 'grimnir'],
    prompt: `Draft a brief, professional email in Swedish. Context:

To: Alex Example (alex@example.com)
Subject: Regarding the proposal adjustment
Purpose: Accept his counter-offer of 150k SEK, confirm we'll remove the performance audit phase, and suggest a kickoff meeting the week of April 14.

Keep it warm but professional. 3-4 short paragraphs max. Sign off as Morgan.`,
    expectedCapabilities: [
      'writes in correct Swedish',
      'accepts the 150k counter-offer explicitly',
      'confirms removal of performance audit phase',
      'suggests kickoff week of April 14',
      'tone is warm but professional',
      'signs off as Morgan',
      'keeps it concise (not overly formal/verbose)',
    ],
  },

  // ---------------------------------------------------------------------------
  // chat-002: Quick translation with context
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-chat-002',
    category: 'non-coding',
    title: 'Translate technical message with context preservation',
    difficulty: 2,
    maxTokens: 600,
    tags: ['chat', 'utility', 'translation', 'grimnir'],
    prompt: `Translate this Slack message from Swedish to English. Preserve the casual tone and any technical terms.

"Hej! Kollade på den där PR:en med auth-migreringen. Ser bra ut överlag men jag undrar över session-token-formatet — vi kanske borde köra opaque tokens istället för JWT med tanke på GDPR-grejen? Taylor sa att hon kollar på det till torsdag. Pinga mig om du vill diskutera."`,
    expectedCapabilities: [
      'preserves casual tone (not overly formal translation)',
      'keeps technical terms intact (PR, auth, session token, JWT, GDPR, opaque tokens)',
      'captures the Thursday timeline',
      'translation is natural English, not word-for-word',
    ],
  },

  // ---------------------------------------------------------------------------
  // librarian-001: Document indexing — generate summary + tags from raw content
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-librarian-001',
    category: 'non-coding',
    title: 'Index a document: generate summary and tags for search',
    difficulty: 3,
    maxTokens: 1000,
    tags: ['librarian', 'indexing', 'metadata', 'grimnir'],
    prompt: `You are a document indexing system. Given a raw document, generate a search index entry so future queries can find it. Return JSON only.

Document (architecture decision record):

---
# ADR-007: Use Cloudflare Tunnel for Pi Ingress

## Status: Accepted (2026-03-15)

## Context
We need external access to services running on the Raspberry Pi (Munin API, Heimdall dashboard, webhook endpoints) without opening router ports or requiring a static IP. The Pi sits behind a consumer-grade NAT with dynamic IP assignment from the ISP.

Options considered:
1. **Port forwarding + DDNS** — fragile, exposes the Pi directly, ISP may block ports
2. **Tailscale only** — works for personal devices but can't serve public webhooks
3. **Cloudflare Tunnel (cloudflared)** — outbound-only connection, no open ports, free tier, handles TLS
4. **Ngrok** — similar to CF Tunnel but paid for custom domains, less control over DNS

## Decision
Use Cloudflare Tunnel via \`cloudflared\` daemon running on the Pi. DNS managed in Cloudflare for \`example.com\` domain. Each service gets a subdomain (e.g., \`munin.example.com\`, \`heimdall.example.com\`).

## Consequences
- No open inbound ports on the home network
- TLS termination handled by Cloudflare edge
- Dependency on Cloudflare (free tier) — acceptable given the alternatives
- Need to run \`cloudflared\` as a systemd service with auto-restart
- Public endpoints must implement their own auth (Cloudflare Access or app-level)
---

Generate a search index entry:
{
  "title": string,
  "summary": string (2-3 sentences, enough to decide if the full doc is worth reading),
  "tags": string[] (topic tags that someone might search for — technology names, concepts, not just structural tags),
  "file_type": "adr" | "plan" | "spec" | "guide" | "report",
  "key_decisions": string[] (1-2 word summaries of decisions made),
  "mentioned_systems": string[] (systems/services referenced)
}`,
    expectedCapabilities: [
      'returns valid JSON',
      'summary captures the core decision (Cloudflare Tunnel) and the why (NAT, no static IP)',
      'tags include specific tech names: cloudflare, tunnel, cloudflared, tailscale, pi, ingress, networking',
      'tags do NOT include useless generic tags like "document" or "decision"',
      'file_type is "adr"',
      'key_decisions includes cloudflare-tunnel choice',
      'mentioned_systems includes munin, heimdall, cloudflared',
    ],
  },

  // ---------------------------------------------------------------------------
  // librarian-002: Relevance ranking — given a query, rank candidate results
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-librarian-002',
    category: 'non-coding',
    title: 'Rank search results by relevance to a query',
    difficulty: 3,
    maxTokens: 1000,
    tags: ['librarian', 'retrieval', 'ranking', 'grimnir'],
    prompt: `You are a search relevance ranker. Given a user query and candidate documents, rank them by relevance. Return JSON only.

User query: "How do we handle authentication for the API?"

Candidate documents:
A) "ADR-007: Use Cloudflare Tunnel for Pi Ingress — Decided to use cloudflared for external access. Services need their own auth layer (Cloudflare Access or app-level)."

B) "ADR-003: Session Token Format — Switched from JWT to opaque reference tokens for session management. Rationale: GDPR compliance — JWTs stored PII in the payload. Opaque tokens keep PII server-side."

C) "Heimdall Dashboard README — Monitoring dashboard for Grimnir services. Displays uptime, memory usage, and error rates. Accessible at heimdall.example.com."

D) "Auth Migration Plan — Phase 1: Remove legacy middleware from 3/4 services. Phase 2: Implement new session management with opaque tokens. Phase 3: Add rate limiting and API key rotation. Payment service migrated last (PCI scope)."

E) "Munin Memory API Spec — RESTful API with bearer token auth. Endpoints: /api/memory/read, /api/memory/write, /api/memory/query. Rate limited to 100 req/min. API keys managed via environment variables."

F) "Q2 Capacity Planning — Need to hire 1 senior engineer. Current team bandwidth at 90%. Example Corp (synthetic) engagement consuming 60% of Morgan's time."

Return:
{
  "ranked": [
    { "id": "X", "relevance": "high" | "medium" | "low" | "none", "reason": string (one sentence) }
  ]
}`,
    expectedCapabilities: [
      'D and E ranked highest (directly about API auth)',
      'B ranked high or medium (auth-related decision)',
      'A ranked medium (mentions auth tangentially)',
      'C ranked low (monitoring, not auth)',
      'F ranked none (completely irrelevant)',
      'reasons are specific and concise',
      'returns valid JSON',
    ],
  },

  // ---------------------------------------------------------------------------
  // librarian-003: Epistemic honesty — know what you don't know
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-librarian-003',
    category: 'non-coding',
    title: 'Distinguish known facts from gaps in available context',
    difficulty: 4,
    maxTokens: 1000,
    tags: ['librarian', 'epistemic', 'honesty', 'grimnir'],
    prompt: `You are a knowledge assistant with access ONLY to the context provided below. Answer the user's questions. For each answer, classify your confidence as:
- KNOWN: The answer is directly stated in the provided context
- INFERRED: The answer can be reasonably inferred but isn't explicitly stated
- UNKNOWN: The context doesn't contain enough information to answer

Context (all available information):
1. "Munin Memory uses SQLite with FTS5 for search. Database stored at /data/munin.db on the Pi."
2. "The Pi runs Ubuntu 24.04 on a Raspberry Pi 5 with 8GB RAM."
3. "Cloudflared connects the Pi to Cloudflare edge. Services exposed: munin.example.com, heimdall.example.com."
4. "Backups run nightly via cron to a Synology NAS at 192.0.2.50."
5. "The Munin API requires a bearer token. Tokens are stored in /etc/munin/runtime.env."

Questions:
1. What database does Munin use?
2. How much disk space does the Munin database use?
3. Is the Munin database backed up?
4. What version of SQLite is installed?
5. Can Munin handle 1000 concurrent requests?
6. Where are the API tokens stored?
7. Is the connection between the Pi and Cloudflare encrypted?

Return JSON array:
[
  { "question": 1, "answer": string, "confidence": "KNOWN" | "INFERRED" | "UNKNOWN", "reasoning": string }
]`,
    expectedCapabilities: [
      'Q1 → KNOWN (SQLite with FTS5)',
      'Q2 → UNKNOWN (disk usage not mentioned anywhere)',
      'Q3 → INFERRED (nightly backups to NAS exist, Munin db is on the Pi, so likely backed up — but not explicitly stated)',
      'Q4 → UNKNOWN (version not mentioned)',
      'Q5 → UNKNOWN (no performance data given)',
      'Q6 → KNOWN (/etc/munin/runtime.env)',
      'Q7 → INFERRED (cloudflared uses TLS by default, but this isn\'t stated in context)',
      'does NOT hallucinate specific values for UNKNOWN questions',
      'INFERRED answers explain the reasoning chain',
      'returns valid JSON',
    ],
  },

  // ---------------------------------------------------------------------------
  // librarian-004: Needle in context — find specific info in a long document
  // ---------------------------------------------------------------------------
  {
    id: 'grimnir-librarian-004',
    category: 'non-coding',
    title: 'Extract specific facts from a long mixed-topic context',
    difficulty: 3,
    maxTokens: 800,
    tags: ['librarian', 'retrieval', 'extraction', 'long-context', 'grimnir'],
    prompt: `Below is a dump of 15 memory entries from different namespaces. Answer the 5 questions that follow. Each answer must cite the entry number(s) used.

Entry 1 (projects/heimdall/status): "Heimdall v2.1.0 deployed. Added CPU temperature monitoring for Pi. Dashboard refresh rate changed from 30s to 10s."
Entry 2 (people/alex): "Alex Example, Example Nordic (synthetic). Phone: +1-202-555-0100. Proposal under negotiation (150k SEK counter-offer)."
Entry 3 (projects/munin-memory/status): "Multi-principal auth matrix complete. Next: expiry GC and compaction. DB size: 847MB."
Entry 4 (decisions/hosting): "All services self-hosted on Pi behind Cloudflare Tunnel. No cloud VMs."
Entry 5 (projects/ratatoskr/status): "Telegram bot operational. Last restart: March 28. Handles ~40 messages/day."
Entry 6 (people/taylor): "Taylor Example — team lead at Example Corp (synthetic). Reviewing GDPR compliance for auth tokens. Target: Thursday."
Entry 7 (business/example-corp): "Synthetic engagement. Revenue: 95k SEK/month. SOW expires in 3 months. CTO leaving end of April."
Entry 8 (projects/skuld/status): "Daily briefing generation working. Uses calendar + tasks + weather API. Runs at 06:30 via cron."
Entry 9 (decisions/search-backend): "Chose SQLite FTS5 over shodh-memory. Reasons: ARM64 support, single maintainer risk, zero added deps."
Entry 10 (meta/backup): "Nightly backup at 02:00 to a storage appliance (192.0.2.50). Retention: 30 days. Includes: /data/, /etc/munin/runtime.env, systemd configs."
Entry 11 (projects/noxctl/status): "CLI stable. Last release: v1.12.0. Handles invoicing and VAT reporting for Fortnox."
Entry 12 (people/morgan/preferences): "Prefers validate-first approach to products. No pricing discussions before MVP locked."
Entry 13 (business/coaching): "VIP AI Coaching. 2 clients, 15k SEK/month. 3 warm leads from conference. One client hinting at Q3 budget cuts."
Entry 14 (meta/conventions): "Namespace scheme: projects/, people/, decisions/, meta/, business/. Tags must be reusable."
Entry 15 (projects/hugin/status): "Task dispatcher running. Worker model: spawn Claude Code sessions via CLI. Average task: 4 minutes."

Questions:
1. What is the current size of the Munin database?
2. Who is the CTO that's leaving, and when?
3. What time do backups run, and how long are they retained?
4. How many messages does Ratatoskr handle daily?
5. Why was shodh-memory rejected?`,
    expectedCapabilities: [
      'Q1: 847MB, cites entry 3',
      'Q2: CTO at Example Corp (synthetic) leaving end of April (name not given), cites entry 7',
      'Q3: 02:00, 30 days retention, cites entry 10',
      'Q4: ~40 messages/day, cites entry 5',
      'Q5: ARM64 support, single maintainer risk, zero added deps — cites entry 9',
      'does not confuse entries or misattribute facts',
      'each answer cites the correct entry number',
    ],
  },
];
