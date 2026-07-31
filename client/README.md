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
npx gille-inference ask "What is the capital of France?"
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

See the
[`m5` agent client guide](https://github.com/Magnus-Gille/gille-inference/blob/main/docs/m5-agent-client.md)
for the profile schema, Keychain account mapping, structured code commands, `claude-config`
installation/versioning contract, and security boundary. The server-side cage and diff-only result
are authoritative; the client never applies a returned diff.
