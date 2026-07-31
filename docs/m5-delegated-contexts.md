# M5 delegated-context support

This document answers a narrow operational question: which *delegated agent
contexts* may be asked to perform bounded M5 work today. It does not provision
credentials, expand tool authority, or make a context an L1 Conductor.

The machine-readable source is
[`m5-delegated-context-matrix.json`](./m5-delegated-context-matrix.json). Run
`node scripts/check-m5-delegated-contexts.mjs` to validate that declaration
offline; it makes no network, Keychain, gateway, ledger, or production-state
call.

| Harness and context | Support | Evidence and permitted surface |
| --- | --- | --- |
| Codex root interactive session | Supported | The original [#72 report](https://github.com/Magnus-Gille/gille-inference/issues/72) records a successful owner `/delegate` call from the root session. |
| Codex repository implementation subagent | Supported | The [#72 owner evidence](https://github.com/Magnus-Gille/gille-inference/issues/72#issuecomment-5065936227) records three bounded `/delegate` receipts: `83084d86-c22b-44c6-906d-0a2b62323523`, `fc5f5c01-670b-43fd-9705-5d8fbf3089d2`, and `0e6f665e-e304-4fba-b79b-5b38e335aea0`. |
| Claude Code real interactive session | Supported operationally | [Redacted acceptance evidence](https://github.com/Magnus-Gille/gille-inference/issues/72#issuecomment-5143969558) records a fresh session discovering its least-privilege M5 MCP tools, completing a bounded isolated code-loop task, and passing its deterministic local test. It is not a capability-promotion or route-promotion receipt. |
| Pi delegated harness leaf | Unsupported | No accepted credential smoke test or bounded delegation receipt exists. Profile-name parsing alone is not evidence that Pi credentials, wiring, and authority are safely supported. |

## Surface and authority boundary

Use the secret-safe [`m5` client](./m5-agent-client.md) for current Claude and
Codex agent profiles. Its `ask` command uses the authenticated MCP `ask` tool;
the gateway records an internal `mcp-ask` ledger row for successful minted-owner
requests, but this client intentionally does not return a ledger ID.

The historical receipts above used `POST /delegate`. That route remains
admin-scope owner-only because it can select any model. Do not convert an
agent-scoped `m5` credential into a direct `/delegate` credential merely to
reproduce an old receipt. Agent-scope M5 work must remain within the MCP tool
and gateway authority boundary.

`m5 doctor` is the preflight for an individual session. Its structured
`missing_credential`, `credential_unavailable`, `wrong_scope`, and
`missing_tools` results are actionable capability results—not evidence of M5
execution. A session that receives one must use its L1 fallback and, where the
adoption contract applies, submit only the content-free fallback observation.

## Bounded context probe

The deterministic test coverage is deliberately split by boundary:

1. `tests/m5-delegated-context-matrix.test.ts` runs the offline matrix
   validator. It fails if a supported context has no declared evidence, if Pi
   is accidentally labelled supported without a receipt, or if secret-shaped
   material appears in the declaration.
2. `tests/homeserver-gateway-spine.test.ts` exercises a bounded
   `taskType: "classify"` owner `/delegate` request against a stub upstream,
   requires `delegated: true`, and reads back its returned ledger ID. It also
   verifies the route rejects a guest key. This is the safe deterministic
   implementation probe for the historical receipt surface.
3. `tests/m5-cli.test.ts` verifies the current profile-based client resolves a
   credential internally and never serializes it while making an MCP `ask`
   call.

No live gateway call should be run merely to refresh this table. A new context
becomes supported only after a bounded classification succeeds with a minted
least-privilege credential, the appropriate deterministic check passes, and a
sanitized evidence record is added to this matrix. Do not publish prompts,
responses, tokens, private locators, or bearer material.
