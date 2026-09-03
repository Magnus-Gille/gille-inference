# gille-inference clients

This package contains two deliberately separate zero-dependency clients:

- `hs` is the friend-facing invite, streaming chat, and usage client described below.
- `m5` is the profile-based, Keychain-backed owner-agent client and stdio MCP bridge.

The box-local operator CLI remains `src/homeserver/cli.ts`; neither packaged client replaces it.
All `example.com` URLs below are reserved documentation examples; replace them with your
deployment URL.

Requires Node 18+ (uses built-in `fetch`). No external dependencies.

## Install

```bash
npm install -g gille-inference
```

Or zero-install with npx:

```bash
npx --package gille-inference hs ask "What is the capital of France?"
```

Alternatively, download directly from the gateway:

```bash
curl -fsSL https://inference.example.com/hs -o ~/bin/hs && chmod +x ~/bin/hs
```

## Quickstart

```bash
# 1. Redeem your invite code — saves credentials to ~/.config/hs/config.json
hs redeem inv_xxxxxxxxxxxxxxxx

# 2. List the models your key may use
hs models

# 3. Ask a question (streams tokens as they arrive)
hs ask "What is the capital of France?"
hs ask -m qwen3.5-35b-a3b --system "You are a code reviewer." "Review this: ..."

# 4. Check your tier, allowed models, and credit usage
hs usage

# 5. Show stored credentials
hs whoami
```

## How it works

`hs ask` calls `POST /v1/chat/completions` with `stream: true`. `hs models` calls `GET /v1/models`. `hs usage` calls `GET /portal/me`. The gateway is plain OpenAI-compatible — you can swap `hs` for any OpenAI SDK at any time by pointing it at `https://inference.example.com/v1`.

## More

Your deployment's root URL serves the portal, invite flow, and client documentation.

## Owner-agent `m5` client

`m5` requires a named profile and resolves its credential internally from macOS Keychain. It has
no bearer-token environment variable, config field, or argv flag. Public profiles require HTTPS;
HTTP is accepted only for an explicitly selected private endpoint, and redirects fail closed.

```bash
m5 --profile codex doctor
m5 --profile codex models
printf '%s' '{"model":"mellum","prompt":"Summarize this."}' | m5 --profile codex ask
m5 --profile codex mcp
```

`m5 ask` prints structured JSON including `finish_reason`, explicit `truncated`, and content-blind
`usage`. A token-limit finish returns `truncated:true` so scripts can retry with a higher
`max_tokens` instead of mistaking an empty or partial answer for a clean completion.

The MCP bridge returns stable, redacted transport diagnostics (`failure_layer`,
`diagnostic_code`, `retryable`, and fixed remediation) for DNS, routing, connection, TLS, timeout,
gateway-health, and authentication failures. Adoption reports return a scoped acknowledgement:
`retention: "retained"` means the row was stored, `retention: "aggregated"` means the bounded
telemetry cap was reached but the observation was folded into a safe aggregate, and
`retention: "dropped"` identifies a telemetry-only refusal. A telemetry cap is never an M5
inference limit: `inference_availability: "unaffected"`, and only the report should wait until
the next UTC day. A connector/transport failure remains `not_recorded` with
`retry_same_tool_call`; no report payload is echoed or silently persisted.

### Provisioning a new owner-agent profile

`m5 provision` is an owner-attended macOS operator ceremony. It creates the
non-secret profile, invokes the fixed live-gateway mint path over SSH, stores
the one-time bearer through the macOS Keychain prompt path, and finishes with a
redacted `doctor` result:

```bash
m5 --profile pi \
  --public-gateway-url https://inference.example.com \
  --m5-host magnus@m5 \
  provision
```

The command requires a non-interactive, owner-authorized SSH path to the M5
host. It rejects an existing profile URL mismatch or Keychain item rather than
silently replacing either; reconcile an existing credential through the normal
rotation procedure first. It never accepts or prints bearer data.

See the
[`m5` agent client guide](https://github.com/Magnus-Gille/gille-inference/blob/main/docs/m5-agent-client.md)
for the profile schema, Keychain account mapping, structured code commands, `claude-config`
installation/versioning contract, and security boundary. The server-side cage and diff-only result
are authoritative; the client never applies a returned diff.
