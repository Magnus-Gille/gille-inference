# Orin Nano backend — deployment and rollback

This is the homeserver integration for the existing tailnet-only Ollama cell. It does not install
or manage Ollama on the Jetson; Hugin #97 owns that bring-up and direct path.

## Ownership and traffic

Hugin is the only macro-router. It may deliberately target Orin through the M5 gateway by sending
`node:"orin"` to `POST /v1/chat/completions`, or `nodeId:"orin"` to owner-only `POST /delegate`.
The gateway does not autonomously pick Orin and does not create a second ledger. The only admitted
model is `qwen2.5-coder:3b`; `/delegate` additionally requires a task type listed in the Orin
allow-list. Existing callers that omit the node keep the byte-for-byte M5 path.

## M5 environment

Set these only on the M5 deployment (the tailnet address is deliberately not in source):

```sh
HOMESERVER_ORIN_URL=http://192.0.2.20:11434
HOMESERVER_ORIN_MODEL=qwen2.5-coder:3b
HOMESERVER_ORIN_ELIGIBLE_TASK_TYPES=classify,extract
HOMESERVER_ORIN_HEALTH_TIMEOUT_MS=2000
```

Restart `home-gateway`, then check `GET /healthz`: it reports `nodes.orin.ok` and whether the
configured model is in Ollama's inventory. `/models` remains the M5 model-management endpoint;
the health result is the remote discovery contract.

## Smoke test

Use an authenticated key that is already allowed to use the model:

```sh
curl -sS "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"node":"orin","model":"qwen2.5-coder:3b","messages":[{"role":"user","content":"Reply exactly OK."}],"max_tokens":16}'
```

Verify the returned answer and then inspect the content-blind `request_log`: `node='orin'`, model,
latency and token columns must be populated. For `/delegate`, the resulting ledger row must have
`node_id='orin'` and `model_id='qwen2.5-coder:3b'`. Neither table contains guest content.

## Failure and rollback

The gateway applies its usual key quota, model allow-list, and owner-preempting admission before
the remote call. An unreachable/timeout Orin gets a bounded 502/504; a drone-lab/Ollama busy error
is normalized as unavailable. Hugin then re-routes the work to M5 or frontier. It must not repeat
an Orin request indefinitely. To disable the remote backend immediately, remove
`HOMESERVER_ORIN_URL` and restart the gateway; requests with `node:"orin"` are rejected, while all
M5 callers continue unchanged. No public listener is added on the Orin.
