# gille-inference

A zero-dependency terminal client for a Gille Inference gateway. Redeem an invite code, list
available models, chat with streaming output, and check your credit usage. All `example.com` URLs
below are reserved documentation examples; replace them with your deployment URL.

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
