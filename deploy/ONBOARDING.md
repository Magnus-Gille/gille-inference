# Using a Gille Inference endpoint

A small, **best-effort** OpenAI-compatible LLM endpoint running on a home machine.
Read [`SLA.md`](./SLA.md) — by using your key you accept it. Short version: it may
be slow or offline, the owner's work always preempts yours, and `503` is normal.

**Self-service portal:** visit [https://inference.example.com](https://inference.example.com)
to redeem an invite link, see your credit balance, and grab ready-to-run code snippets.
The "How to use it" section on that page covers the HTTP API, MCP (Claude Code), and the
CLI — you can self-serve from there without reading further.

**CLI (hs):** a zero-dependency Node 18+ wrapper served directly from the gateway. One-liner install:

```bash
curl -fsSL https://inference.example.com/hs -o ~/bin/hs && chmod +x ~/bin/hs
```

Or via npm: `npm install -g gille-inference` (or zero-install: `npx gille-inference ask "..."`).

## What you were given

```
base_url:  https://inference.example.com/v1
api_key:   hs_guest_xxxxxxxxxxxxxxxxxxxxxxxx     (yours — do not share)
model(s):  <the model name(s) your key is allowed>
```

List the models your key can use:

```bash
curl https://inference.example.com/v1/models -H "Authorization: Bearer $HS_KEY"
```

## Call it

It's plain OpenAI-compatible — point any OpenAI client at the `base_url` and key.

**curl:**
```bash
curl https://inference.example.com/v1/chat/completions \
  -H "Authorization: Bearer $HS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5-35b-a3b",
       "messages":[{"role":"user","content":"hi"}],
       "stream":true}'
```

**OpenAI Python:**
```python
from openai import OpenAI

client = OpenAI(base_url="https://inference.example.com/v1", api_key="hs_guest_...")

resp = client.chat.completions.create(
    model="qwen3.5-35b-a3b",
    messages=[{"role": "user", "content": "hi"}],
    stream=True,            # IMPORTANT — see below
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

## Use it from Claude Code (MCP — offload sub-tasks to the box)

Add the box to Claude Code as an MCP server in **one command** — then Claude can offload
self-contained sub-tasks (code gen / refactor, drafting, classification, summarization,
short reasoning) to the local models **as tools**, keeping the data on the box and saving
frontier tokens:

```bash
claude mcp add --transport http local-llm https://inference.example.com/mcp \
  --header "Authorization: Bearer hs_..."
```

It uses the **same key** as the OpenAI-compatible endpoint above, so the **same credits and
the same model allow-list apply** — calls through MCP draw down your credit budget exactly
like a `/v1/chat/completions` call would. Two tools are exposed:

- **`list_models`** — the models your key may use via `GET /v1/models`, each with a one-line strength hint.
- **`ask`** — `{model, prompt, system?, max_tokens?, delegator_model_id?}` → runs a completion via `POST /v1/chat/completions` on the chosen local
  model and returns the text. A model outside your allow-list, an exhausted credit budget, a
  quota hit, or a busy box come back as a tool error (with a clear message), not a crash.
  Owner/cloud-agent callers should pass `delegator_model_id` (for example `openai/gpt-5.5` or
  `anthropic/claude-sonnet-4-6`) so the M5 savings dashboard can estimate actual cloud spend avoided.

## CLI (`hs`) — optional convenience wrapper

If you prefer a command-line shortcut over raw curl or an SDK, install `hs` from the gateway:

```bash
# one-time install (anywhere on $PATH)
curl -fsSL https://inference.example.com/hs -o ~/bin/hs && chmod +x ~/bin/hs
# or via npm
npm install -g gille-inference
```

Requires Node 18+ (uses built-in `fetch`). Zero external dependencies.

**Redeem your invite code and save credentials:**
```bash
hs redeem inv_xxxxxxxxxxxxxxxx
# Stores ~/.config/hs/config.json (chmod 0600) automatically
```

**List the models your key may use:**
```bash
hs models
```

**Ask a question (streams tokens as they arrive):**
```bash
hs ask What is the capital of France?
hs ask -m qwen3.5-35b-a3b --system "You are a code reviewer." "Review this: ..."
```

**Check your credit usage:**
```bash
hs usage
```

It is just the OpenAI API + portal endpoints under the hood — `hs models` calls
`GET /v1/models`, `hs ask` calls `POST /v1/chat/completions` with `stream:true`, and
`hs usage` calls `GET /portal/me`. You can swap it for any OpenAI-compatible SDK at
any time.

## The one thing you must know: use `stream=True`

Cloudflare cuts any single request at **~100 seconds** (you'd get a `524`).
Streaming emits the first token long before that and keeps the connection alive,
so long generations don't get severed. Always stream for non-trivial completions,
and keep `max_tokens` reasonable (the server caps it at 12288 regardless).

## You must name a `model`

If your key is restricted to specific models, you **must** include the `model`
field (omitting it is rejected with `403`). Use a name from `GET /v1/models`.

## Privacy — what is and isn't logged

Your **prompts and responses are NOT stored.** The only thing recorded for guest traffic is
content-blind metadata — a per-key pseudonym (your alias), the model, timing (including
time-to-first-token), token counts, and the outcome — used to keep the box healthy and fairly
shared. No prompt text, no response text, no IP addresses. Content capture exists *only* for the
operator's own owner key, never for guests. Full details and retention guidance:
[`../docs/observability.md`](../docs/observability.md).

## Errors — what they mean and what to do

All errors are OpenAI-error-shaped (`{"error":{"message","type","code"}}`), so
your SDK's error handling works. Honor `Retry-After` on `429`/`503`.

| HTTP | `code` | Meaning | What to do |
|---|---|---|---|
| `400` | `invalid_request_error` / `model_not_found` | bad body, or unknown model name | fix the request; check `GET /v1/models` |
| `401` | `invalid_api_key` | missing / wrong / revoked key | check your key, or ask the operator |
| `403` | `model_not_allowed` | your key is restricted to specific models and the requested model is not in its allow-list | use an allowed model from `GET /v1/models` |
| `403` | `route_not_allowed` | that endpoint is owner-only (e.g. `/delegate`) | use `/v1/chat/completions` |
| `429` | `rate_limit_exceeded` | you hit your RPM / TPM / daily budget | back off; honor `Retry-After` |
| `503` | `server_busy` | box is busy / owner has priority | **normal** — retry with backoff + jitter |

`429` = *your* quota (slow down). `503` = *the box* is busy (just retry later).
A `503` is **not** a bug in your request.

---

### Operator note (minting a guest key)

On the box (loopback), with the gateway running:

```bash
tsx src/homeserver/cli.ts keys mint \
  --alias alice --tier guest \
  --models qwen3.5-35b-a3b \
  --rpm 4 --tpm 20000 --daily 500000 --parallel 1 --ttl 7776000   # 90 days
```

The plaintext key prints **once** (only its SHA-256 hash is stored). Revoke with
`keys revoke --alias alice`; list with `keys list`. Always set a non-zero
`--daily` so a leaked key is damage-capped.
