# Secret-safe `m5` agent client

`m5` is the owner-agent client for the M5 gateway. It is distinct from both existing command
surfaces:

- `hs` remains the self-contained friend-facing invite/chat/usage client.
- `src/homeserver/cli.ts` remains the box-local operator and administration CLI.
- `m5` is the secret-safe client substrate for Claude, Codex, and shell automation.

MCP remains the discoverable agent protocol. `m5 mcp` is a stdio-to-HTTP bridge, not another MCP
server implementation: every accepted JSON-RPC message is forwarded to the fixed gateway `/mcp`
route.

## Installation and versioning contract

The `m5` executable ships in the same npm package as `hs`, starting with client package version
`1.3.0`:

```bash
npm install --global gille-inference@1.3.0
m5 --version
```

`gille-inference@1.0.0` is the existing public `hs`-only package. The initial M5 client was
prepared as `1.1.0` but was never published; `1.2.0` added the required content-free adoption
reporting contract as the first public M5-capable version. `1.2.1` kept that surface and added
the structured `list_models` blind-context discovery contract. Version `1.3.0` adds guided
owner-agent profile provisioning.

Deploy note: a gateway that serves structured `list_models` discovery must preserve the published
`m5 1.2.0` wire contract by omitting `structuredContent` for the `m5-cli/1.2.0` user-agent.
`m5 1.2.1+` and other MCP callers may receive the structured object.

`m5 --version` emits structured JSON. `claude-config` integrations must:

1. Pin an exact accepted `gille-inference` client version rather than `latest`.
2. Verify the emitted `m5` version before changing an MCP registration.
3. Register only the executable and non-secret profile/path selector arguments.
4. Put no bearer, `Authorization` header, credential environment variable, or private locator in
   the harness configuration.
5. Upgrade the pinned version only after this repository's client tests and the target harness
   smoke test pass.

A public-path Claude registration has this data shape:

```json
{
  "command": "m5",
  "args": ["--profile", "claude", "mcp"]
}
```

For a private-network registration, append `--private`. The private locator still comes from the
local `m5` profile file; it is not copied into harness configuration or diagnostic output.

The npm package is the versioned distribution authority. The gateway's unauthenticated `/hs`
download remains the single-file `hs` client and does not serve or version `m5`.

## Profile configuration

The non-secret configuration lives at `~/.config/m5/config.json`:

```json
{
  "version": 1,
  "profiles": {
    "claude": {
      "publicGatewayUrl": "https://inference.example.com",
      "privateGatewayUrl": "http://inference-node:8080"
    },
    "codex": {
      "publicGatewayUrl": "https://inference.example.com",
      "privateGatewayUrl": "http://inference-node:8080"
    }
  }
}
```

The URLs above are examples. `publicGatewayUrl` must use HTTPS. HTTP is accepted only for the
explicit `privateGatewayUrl` path selected with `--private`; HTTPS also works there. These are the
only two allowed profile fields: credential-like and unknown fields are rejected rather than
ignored. Keep private locator files local and out of Git.

The credential itself lives in macOS Keychain under service `gille-inference`. Accounts are
derived mechanically from the selected profile:

| Profile | Keychain account |
|---|---|
| `claude` | `gateway-agent-claude` |
| `codex` | `gateway-agent-codex` |

This makes the two least-privilege credentials independently revocable. Provisioning and rotation
remain owner-attended operator actions. This client's guided provisioning command mints a fresh
`owner` / `agent` credential only through the fixed live gateway path described below; the
repository and client configuration never contain bearer values.

### Guided provisioning

Client version 1.3.0 adds a macOS owner-attended provisioning command for a new
profile:

```bash
m5 --profile pi \
  --public-gateway-url https://inference.example.com \
  --m5-host magnus@m5 \
  provision
```

It validates and writes only the profile's public HTTPS URL, checks that the
profile-specific Keychain item is absent, and then calls the fixed SSH operator
path that enters the live `home-gateway.service` mount namespace before minting
an `owner` / `agent` credential. The bearer travels only from that process's
stdout to the local Keychain prompt over stdin; it is neither returned by the
CLI nor accepted in command arguments, environment variables, or config.

The command refuses an existing Keychain item or a public-URL mismatch; it does
not guess whether the corresponding remote credential should be rotated or
revoked. If Keychain persistence fails after a mint, it makes a bounded attempt
to revoke that exact new alias and emits a redacted failure result. A completed
command emits only the structured `m5 doctor` outcome.

`--profile` is mandatory. There is no implicit shared/default account, bearer environment
variable, bearer argv flag, or credential field in client config.

### Deployment environment

For an owner-attended gateway deployment, load the deploy script's environment into the current
shell with this exact invocation:

```bash
eval "$(m5 --profile codex deploy-env)"
```

`deploy-env` emits shell source specifically for that outer `eval`; do not run it merely to print
the source. The source first evaluates `m5-auth --env --tailnet`, copies its `M5_API_KEY` into the
deploy script's `HOMESERVER_OWNER_KEY`, and immediately unsets `M5_API_KEY`. It derives
`DEPLOY_HEALTH_TAILNET_URL` and `DEPLOY_CAPABILITY_URL` from the authenticated helper's
`M5_GATEWAY_URL`. It also exports `DEPLOY_PUBLIC_HTTP_URL` and `DEPLOY_PUBLIC_HTTPS_URL` from the
selected profile's validated `publicGatewayUrl`, so neither a live public hostname nor a private
tailnet locator needs to be committed or hardcoded in the client.

The command reads and validates the selected non-secret profile but does not resolve its Keychain
credential and never emits a bearer. `--private` is rejected: the tailnet endpoint and credential
belong to `m5-auth --env --tailnet`, while the profile supplies only the public verification
origin. Generated literal origins are shell-quoted before emission.

## Commands

Except for the `deploy-env` shell-source command above, every automation command writes one JSON
value to stdout. Errors are JSON on stderr. Prompts and inline seed files are supplied as bounded
JSON on stdin so they do not require shell quoting.

```bash
m5 --profile codex doctor
m5 --profile codex models

printf '%s' '{"model":"mellum","prompt":"Classify this bounded input."}' \
  | m5 --profile codex ask

printf '%s' '{"harness":"codex_cli","execution_mode":"code_loop","traffic_purpose":"organic","result":"not_attempted","deterministic_check":"not_run","reviewer_usefulness":"not_reported","fallback_reason":"m5_auth_unavailable","eligible_opportunities":1}' \
  | m5 --profile codex adoption report

printf '%s' '{
  "instruction": "Update the supplied seed file and run its focused check.",
  "files": [{"path":"src/example.ts","content":"export const value = 1;\n"}],
  "check_cmd": "npm test",
  "protected": ["package-lock.json"]
}' | m5 --profile codex code run

m5 --profile codex code status cl-example
m5 --profile codex code result cl-example
```

`m5 ask` returns structured JSON:

```json
{
  "model": "mellum",
  "text": "answer text",
  "finish_reason": "stop",
  "truncated": false,
  "metered": true,
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 34,
    "total_tokens": 46,
    "reasoning_tokens": null,
    "cache_creation_input_tokens": null,
    "cache_read_input_tokens": null
  }
}
```

If the backend ends with `finish_reason:"length"`, `m5 ask` still returns the same JSON shape,
but with `truncated:true` and `metered:true`, so automation can retry with a higher `max_tokens`
instead of treating an empty or partial answer as a normal completion. The CLI preserves its
current exit semantics: truncation still exits `0` with structured JSON, while ordinary tool
errors still exit `1` with a redacted stderr JSON envelope. Truncation is already billable on the
first call, and any retry is a new metered request. Usage fields remain content-blind; the client
accepts `null` usage, derives `total_tokens` only when prompt+completion counts are both valid,
and nulls malformed negative or fractional counters instead of trusting them.

`code run` starts the server-side async job, polls it, and returns the terminal structured result,
including the unified diff and verification evidence. It can use `"wait": false` to return the
start response for later `status`/`result` calls. It never applies the diff, writes into a live
checkout, or treats client defaults as sandbox enforcement. The gateway's OS cage, input
validation, protected paths, caps, and diff-only result remain authoritative.

## Doctor states

`m5 doctor` checks, in order:

1. profile-specific Keychain presence;
2. gateway reachability;
3. authenticated identity;
4. `owner` plus `agent|admin` route scope;
5. visibility of `list_models`, `ask`, all three `code_loop_*` tools, and `record_adoption_evidence`;
6. identity and tool parity between configured public and private paths.

Its top-level `status` distinguishes:

- `missing_credential`
- `credential_timeout`
- `credential_unavailable`
- `rejected_credential`
- `network_failure`
- `wrong_scope`
- `missing_tools`
- `path_parity_failed`
- `healthy`

No token or endpoint locator is included in the result.

`m5 1.2.0` added the direct, content-free `adoption report` command and requires the reporting tool
for a healthy doctor result. A generic `1.1.0` stdio bridge can still pass an MCP tool call through
when a compatible server exposes it, but it does not provide the direct report command or this
doctor parity check. `m5 1.2.1` keeps that requirement and additionally expects the structured
`list_models` discovery contract when the gateway identifies it as a `1.2.1+` client;
`1.2.1` is therefore the minimum client version for integrations that use adoption measurement or
blind-context discovery. Guided provisioning requires the current accepted exact `1.3.0` pin.

## Transport and redaction behavior

The bridge accepts one newline-delimited JSON-RPC message at a time. It preserves the MCP session
identifier returned by `initialize`, accepts notification `202`/empty responses without emitting
stdout, rejects malformed input and upstream envelopes locally, bounds each HTTP request through
response-body consumption, and continues serving later messages after a failed request. A stale
HTTP MCP session (`404`/`410`) is retried once without the session identifier.

The Keychain value is captured inside the client process and used only to construct the outbound
HTTP `Authorization` header. It is never exported, passed to a subprocess, accepted from client
config/argv, printed, logged, or persisted as an artifact. Error paths discard upstream bodies and
redact bearer/token-shaped values, including Keychain subprocess failures and malformed upstream
JSON-RPC errors. Keychain lookup is itself bounded and distinguishes a missing item from timeout or
service failure. Authenticated HTTP requests use `redirect: error`, so the bearer is never
automatically forwarded to a redirect target.

`hs` remains a single-file, zero-dependency download served at `/hs`; importing the multi-file
agent library into it would break that installation contract. The narrower `m5-client.mjs` library
is shared by all `m5` commands and the stdio bridge so their route, timeout, session, tool-result,
and redaction semantics do not fork.
