import type { TaskDefinition } from '../types.js';

// Every person, organization, address, and commercial detail in this file is synthetic test data.

// A fictional REST API document used for the retrieval QA task.
const FICTIONAL_API_DOCUMENT = `
# Nordljus Weather API — Developer Reference (v2.3)

## Overview

The Nordljus Weather API provides real-time and forecast weather data for Scandinavian cities. It is a REST API using JSON over HTTPS. All requests require a valid API key passed as a Bearer token in the Authorization header.

Base URL: https://weather.example.com/v2

## Authentication

All endpoints require an Authorization header:
  Authorization: Bearer <your-api-key>

API keys are issued through the synthetic developer portal at https://weather.example.com/developers. Free tier keys are rate-limited to 100 requests per hour. Pro tier keys have no hard rate limit but are subject to fair-use throttling at 10 000 requests per minute.

## Endpoints

### GET /weather/current

Returns current weather conditions for a location.

Query parameters:
- city (required): City name, e.g. "Stockholm" or "Tromsø". UTF-8 encoded.
- country (optional): ISO 3166-1 alpha-2 country code to disambiguate city names. Default: SE (Sweden).
- units (optional): "metric" (default) or "imperial".

Response fields:
- city: Canonical city name as stored in the database
- country: ISO country code
- temperature: Number, degrees Celsius (metric) or Fahrenheit (imperial)
- feels_like: Number, apparent temperature
- humidity: Integer, percentage 0-100
- wind_speed: Number, m/s (metric) or mph (imperial)
- wind_direction: String, compass direction (e.g. "NNW")
- conditions: String, short description (e.g. "Partly cloudy")
- icon_code: String, reference to icon set at https://icons.nordljus.io/{icon_code}.png
- observed_at: ISO 8601 timestamp in UTC
- data_source: String, identifies the upstream weather station or model used

Example response:
{
  "city": "Stockholm",
  "country": "SE",
  "temperature": 3.2,
  "feels_like": -1.1,
  "humidity": 78,
  "wind_speed": 5.4,
  "wind_direction": "SW",
  "conditions": "Light snow",
  "icon_code": "snow_light_day",
  "observed_at": "2024-02-14T09:15:00Z",
  "data_source": "SMHI_OBS_SE"
}

### GET /weather/forecast

Returns a 7-day hourly forecast.

Query parameters:
- city (required): Same as /weather/current
- country (optional): Same as /weather/current
- hours (optional): Number of hours ahead to forecast, 1-168 (default: 24)
- units (optional): Same as /weather/current

Response: An object with a "forecasts" array, each element having the same fields as /weather/current plus:
- valid_from: ISO 8601 timestamp marking the start of the forecast period
- valid_to: ISO 8601 timestamp marking the end of the forecast period
- confidence: Float 0.0-1.0, model confidence score for this period

Note: Forecast data older than 6 hours should be considered stale. Clients should refresh at least every 6 hours for forecasts beyond 24 hours, and every 30 minutes for forecasts within the next 24 hours.

### GET /stations/nearby

Returns weather stations near a coordinate pair.

Query parameters:
- lat (required): Latitude, decimal degrees, -90 to 90
- lon (required): Longitude, decimal degrees, -180 to 180
- radius_km (optional): Search radius in km, default 50, max 500

Response: Array of station objects, each with:
- station_id: String identifier
- name: Human-readable name
- lat, lon: Coordinates
- elevation_m: Integer, meters above sea level
- active: Boolean, whether the station is currently reporting
- last_report: ISO 8601 timestamp of most recent data

### POST /alerts/subscribe

Subscribe to weather alerts for a location.

Request body (JSON):
- city (required): City name
- country (optional): ISO country code
- conditions (required): Array of condition codes to trigger on. Valid codes: "heavy_snow", "ice_road", "strong_wind", "fog", "heavy_rain", "thunderstorm"
- webhook_url (required): HTTPS URL to receive POST notifications
- threshold_hours (optional): How many hours ahead to warn, default 3, max 72

Response: 201 Created with a subscription object:
- subscription_id: UUID string
- created_at: Timestamp
- expires_at: Timestamp (subscriptions auto-expire after 90 days)

## Error Codes

400 Bad Request: Missing required parameter or invalid value. Response includes "error" and "details" fields.
401 Unauthorized: Missing or invalid API key.
404 Not Found: City not found in the database. The response "suggestions" field may contain similar city names.
429 Too Many Requests: Rate limit exceeded. Response headers include X-RateLimit-Reset with Unix timestamp.
500 Internal Server Error: Upstream data source unavailable. Use exponential backoff.

## Rate Limiting Headers

All responses include:
- X-RateLimit-Limit: Requests allowed per hour
- X-RateLimit-Remaining: Requests remaining in current window
- X-RateLimit-Reset: Unix timestamp when the window resets

## Data Freshness

Current weather data is updated every 10 minutes from observation stations and every 15 minutes from numerical weather prediction models. The data_source field in the response indicates which was used for a given city.

## Localization

City names may include non-ASCII characters (e.g. "Tromsø", "Göteborg"). All city names in requests must be UTF-8 encoded. The API returns canonical city names as stored in the database, which may differ from the input (e.g. input "Gothenburg" returns "Göteborg").

## Changelog

v2.3 (2024-01-15): Added confidence field to forecast responses. Added data_source field to current weather responses.
v2.2 (2023-09-01): Added POST /alerts/subscribe endpoint. Increased maximum forecast horizon from 72 to 168 hours.
v2.1 (2023-04-10): Added wind_direction field. Deprecated the /weather/hourly endpoint (removed in v2.2).
v2.0 (2023-01-01): Breaking change — moved from API key in query param to Bearer token auth. Unified metric/imperial via units param.
`.trim();

// A fictional technical discussion thread used for the summarization task.
const TECH_DISCUSSION_THREAD = `
Slack thread: #architecture — "How should we handle state sync between the mobile app and backend?"
2024-02-28, various times

---
[09:14] Alex Example: OK so we need to decide how state sync works before the sprint ends. Current situation: mobile app does full refresh on every app foreground. Users with slow connections complain it takes 3-4 seconds. Proposal A: polling (every 30s), Proposal B: WebSocket push, Proposal C: keep full refresh but optimize the endpoint.

[09:22] Casey Example: I've looked at the numbers. 70% of the time when users foreground the app, nothing has changed since last open. So we're doing a lot of unnecessary work. Full refresh = 340ms median on 4G, 2.8s on 3G. That's where the complaints come from.

[09:31] Pat Example: WebSocket is the right answer here. We already have it for the chat feature. Just extend the existing socket to push state deltas. No polling, instant updates, connection reuse. I don't understand why we're even debating this.

[09:38] Alex Example: Because WebSocket adds complexity. What happens on reconnect? What's the authoritative source if events are missed? We'd need to keep a proper event log on the backend, which we don't have. The mobile client also has to handle the "stale state after reconnect" problem.

[09:45] Riley Example (PM): From a user perspective the 3-4 second wait feels bad but only when they're actively waiting for something to appear. Is this actually in the user's critical path? Our analytics show 60% of foreground events are incidental (checking time, switching apps) with no active task.

[09:52] Casey Example: Petra makes a good point. Most painful case is: user gets a push notification, taps it, app foregrounds, user expects to see the new state immediately. THAT is the case we need to fix. Regular idle foregrounds matter less.

[09:58] Pat Example: WebSocket still solves this better. The state is already pushed by the time the user taps the notification.

[10:05] Alex Example: Proposal D just occurred to me: on push notification receipt (background fetch), prefetch the relevant data and cache it. When user opens, cache hit. No WebSocket complexity.

[10:12] Jordan Example (iOS): Background fetch on iOS is unreliable — the system throttles it heavily, especially for apps not in the top usage tier. We can't count on it. Also battery.

[10:19] Casey Example: So options are realistically: WebSocket or optimize the endpoint. The endpoint optimization (Proposal C) would be: version tokens per entity, mobile sends its current versions, backend diffs and returns only changes. Similar to what Figma and Linear do.

[10:28] Pat Example: That's basically reinventing WebSocket but worse because you still need the client to initiate. You're solving latency on the happy path (nothing changed) but not push latency.

[10:35] Alex Example: I think we're conflating two problems. Problem 1: unnecessary work when nothing changed. Problem 2: stale state when things do change. WebSocket solves Problem 2 well but adds complexity. Optimized endpoint solves Problem 1 well. What's our priority?

[10:44] Riley Example (PM): Based on support tickets, Problem 2 (users seeing stale data) generates 3x the complaints of Problem 1 (slow load). The "I did X and it didn't show up" is the killer. Slow load is annoying but tolerated.

[10:51] Jordan Example (iOS): If we do WebSocket, I need at least 2 weeks to handle reconnect logic, offline queueing, and the state reconciliation on reconnect. That's not trivial on iOS. On Android probably similar.

[10:58] Casey Example: What if we do the optimized endpoint NOW (sprint 12) to fix Problem 1 immediately, and plan WebSocket for Q3? The endpoint change is maybe 3 days backend + 1 day mobile. Ship quick relief, proper fix later.

[11:04] Pat Example: I disagree. We'll ship the quick fix and then it'll "work well enough" forever and we'll never do the WebSocket. I've seen this before. We should do it right.

[11:09] Alex Example: Marcus has a point about the tactical trap, but Sara's right that we have a sprint commitment. Compromise: implement the optimized endpoint this sprint, add WebSocket to Q3 roadmap with a hard date (not "maybe"). Agreed?

[11:14] Pat Example: Fine. But I want it on the roadmap with commitment, not as a future consideration.

[11:16] Riley Example (PM): Agreed. I'll add it to Q3 planning doc. @Jordan can you scope WebSocket reconnect behavior this sprint so we have a proper estimate for Q3?

[11:18] Jordan Example (iOS): Yes, I'll have a scoping doc by Friday.

[11:19] Casey Example: One more thing: the optimized endpoint — we need to decide on the versioning scheme. ETag per-resource or a single "state version" token per user?

[11:24] Pat Example: ETag per resource is more granular but more state to track on mobile. Single version token is simpler. I'd go single token for now, we can make it more granular later if needed.

[11:27] Alex Example: OK. Single version token. Sara, can you own the backend spec and share with mobile by tomorrow EOD?

[11:28] Casey Example: Yes.

[11:29] Alex Example: Closing the thread. Decision: optimized endpoint with single version token this sprint, WebSocket Q3 with hard date. Jordan scopes WS by Friday, Sara owns endpoint spec by tomorrow.
`.trim();

// A Swedish-language email containing invoice details for the extraction task.
const SWEDISH_INVOICE_EMAIL = `
Från: invoice@example.com
Till: accounts@example.com
Ämne: Faktura 2024-0392 — konsultuppdrag februari
Datum: 2024-03-01

Hej,

Hoppas det är bra med dig! Jag skickar nu fakturan för februari månads arbete. Vi hann med rätt mycket, bland annat färdigställandet av integrationen mot er betalningsleverantör samt dokumentationen som ni efterfrågade.

Fakturadetaljer:

Fakturanummer: 2024-0392
Fakturadatum: 2024-03-01
Förfallodatum: 2024-03-31

Tjänst: Konsulttjänster webbutveckling, februari 2024
Timmar: 48 timmar à 1 350 kr
Belopp exkl. moms: 64 800 kr
Moms (25%): 16 200 kr
Totalt att betala: 81 000 kr

Betalningsinformation:
Bankgiro: 5502-7891
Märk betalningen med fakturanummer 2024-0392.

En liten notering: om betalning sker innan den 15 mars erbjuder jag 2% kassarabatt, dvs 79 380 kr totalt. Kontakta mig om ni vill utnyttja rabatten så skickar jag en kreditnota.

Om ni har frågor om fakturan eller arbetet är ni välkomna att höra av er. Vi har planerat att ses för genomgång av mars arbetsplan den 6 mars kl 10, stämmer det fortfarande?

Med vänlig hälsning,
Anders Bergström
Bergström Konsult AB
Org.nr: 559123-4567
Telefon: 070-123 45 67
`.trim();

export const NON_CODING_TASKS: TaskDefinition[] = [
  {
    id: 'noncoding-001',
    category: 'non-coding',
    title: 'Retrieval QA over Technical Docs',
    difficulty: 3,
    maxTokens: 2000,
    tags: ['retrieval', 'qa', 'comprehension'],
    prompt: [
      'You are given the following technical API documentation. Read it carefully, then answer the 5 questions below. For each answer, cite the relevant section of the document.',
      '',
      '---',
      FICTIONAL_API_DOCUMENT,
      '---',
      '',
      'Questions:',
      '1. What HTTP header must all requests include, and what are the two tier options for API keys?',
      '2. A client calls GET /weather/forecast with hours=48. How often should it refresh this data, and why?',
      '3. A developer tries to look up "Gothenburg" and gets a 404 response. What field in the error response might help them, and what might the correct city name be?',
      '4. What was the breaking change introduced in API v2.0?',
      '5. A developer wants to be notified when heavy snow is forecast for Oslo. What endpoint should they use, what request body fields are required, and how long will the subscription stay active?',
    ].join('\n'),
    expectedCapabilities: [
      'accurate extraction',
      'handles ambiguity',
      'cites relevant sections',
      'admits uncertainty when info is missing',
    ],
  },

  {
    id: 'noncoding-002',
    category: 'non-coding',
    title: 'Summarize Technical Discussion',
    difficulty: 3,
    maxTokens: 1500,
    tags: ['summarization', 'extraction'],
    prompt: [
      'You are given the following Slack thread where a team debated a technical decision. Produce a structured summary with these sections:',
      '',
      '1. **Decision made** (1-2 sentences): What was decided?',
      '2. **Alternatives considered** (bullet list): What options were on the table?',
      '3. **Key arguments for the decision**: Main reasons why the chosen approach was selected.',
      '4. **Key arguments against / dissenting views**: What concerns were raised, and by whom?',
      '5. **Action items** (bullet list with owner and due date where specified):',
      '',
      '---',
      TECH_DISCUSSION_THREAD,
      '---',
      '',
      'Be concise. The summary should be readable in 2 minutes. Do not invent information not present in the thread.',
    ].join('\n'),
    expectedCapabilities: [
      'identifies the decision',
      'captures dissenting views',
      'extracts action items',
      'structured output',
    ],
  },

  {
    id: 'noncoding-003',
    category: 'non-coding',
    title: 'Extract Invoice Data from Swedish Email',
    difficulty: 3,
    maxTokens: 1000,
    tags: ['swedish', 'extraction', 'structured-output'],
    prompt: [
      'Extract the invoice information from the following Swedish-language email. Return the result as a JSON object with exactly these fields:',
      '',
      '```json',
      '{',
      '  "invoiceNumber": "string",',
      '  "invoiceDate": "YYYY-MM-DD",',
      '  "dueDate": "YYYY-MM-DD",',
      '  "senderCompany": "string",',
      '  "senderOrgNumber": "string",',
      '  "amountExclVat": number,',
      '  "vatAmount": number,',
      '  "vatRate": number,',
      '  "totalAmount": number,',
      '  "currency": "SEK",',
      '  "paymentReference": "string",',
      '  "paymentMethod": "string",',
      '  "earlyPaymentDiscount": {',
      '    "available": boolean,',
      '    "discountedTotal": number | null,',
      '    "deadlineDate": "YYYY-MM-DD" | null',
      '  }',
      '}',
      '```',
      '',
      'Return only valid JSON with no additional text. All amounts should be numbers (not strings). If a field cannot be determined from the email, use null.',
      '',
      '---',
      SWEDISH_INVOICE_EMAIL,
      '---',
    ].join('\n'),
    expectedCapabilities: [
      'Swedish language comprehension',
      'structured extraction',
      'correct number parsing',
      'handles early payment discount details',
    ],
  },

  {
    id: 'noncoding-004',
    category: 'non-coding',
    title: 'MCP Tool Planning',
    difficulty: 4,
    maxTokens: 2000,
    tags: ['planning', 'tool-use', 'mcp'],
    prompt: [
      'You have access to these MCP tools:',
      '',
      '- `memory_write(namespace: string, key: string, content: string, tags?: string[]): void`',
      '- `memory_read(namespace: string, key: string): string | null`',
      '- `memory_query(query: string, tags?: string[], namespace?: string): Array<{namespace, key, content, tags}>`',
      '- `memory_list(namespace?: string): Array<{namespace, key, updatedAt}>`',
      '- `memory_delete(namespace: string, key: string): void`',
      '',
      'Plan how to accomplish the following task. Provide the exact sequence of tool calls with realistic example parameters. Explain your reasoning for each step.',
      '',
      '**Task:** The user wants to reorganize their project notes. They have notes scattered across namespaces `projects/alpha`, `projects/beta`, and `misc/notes`. They want to:',
      '1. Find all notes tagged "architecture" across all three namespaces',
      '2. For each project (alpha and beta), merge the relevant architecture notes into a single consolidated document',
      '3. Delete the original individual notes that were merged',
      '4. Update a master index at `meta/index` key `project-architecture-index` with a summary of what now exists',
      '',
      'Consider: What order should these steps happen? What could go wrong? How would you avoid data loss?',
    ].join('\n'),
    expectedCapabilities: [
      'correct tool selection',
      'proper sequencing',
      'handles dependencies between steps',
      'considers failure modes',
      'realistic parameters',
    ],
  },

  {
    id: 'noncoding-005',
    category: 'non-coding',
    title: 'Multi-turn Conversational Help (Hackathon Booth)',
    difficulty: 3,
    maxTokens: 3000,
    tags: ['conversational', 'teaching', 'multi-turn', 'hackathon'],
    prompt: [
      'Simulate a multi-turn conversation with a complete beginner at a hackathon booth. They have no programming background.',
      '',
      'Respond to each message in sequence. Write your response to message 1, then message 2, then message 3, then message 4. Label each response clearly (e.g., "**Response 1:**").',
      '',
      '**Message 1:** "I want to make a website that shows the weather for my city. I have no idea how to program. Where do I start?"',
      '',
      '**Message 2:** "What\'s HTML?"',
      '',
      '**Message 3:** "OK I found an HTML tutorial and made a page. I added a form where you type in a city name and press a button, but nothing happens when I click the button. What am I missing?"',
      '',
      '**Message 4:** "This is getting complicated. Can you just give me the whole thing that works? Even if I don\'t understand all of it yet, I want to see it working first."',
      '',
      'Evaluation criteria:',
      '- Response 1: Does not overwhelm. Gives a concrete starting point, not a list of 10 things to learn.',
      '- Response 2: Clear, short, uses analogy. No jargon.',
      '- Response 3: Correctly identifies that JavaScript is needed for interactivity. Does not lecture.',
      '- Response 4: Provides working code (HTML + JS, using a free weather API like Open-Meteo which requires no API key). Code should actually work. Encourages the learner.',
    ].join('\n'),
    expectedCapabilities: [
      'appropriate for beginners',
      'progressive disclosure',
      'does not overwhelm',
      'provides working code eventually',
      'encouraging tone',
    ],
  },
];
