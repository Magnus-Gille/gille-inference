#!/usr/bin/env bash
# TEMPLATE, not the installed hook: @@REMOTE_DIR@@ is replaced by deploy-gateway.sh with the
# verified live WorkingDirectory. Secrets remain in that tree's box-local .env and are never
# rendered into this file.
#
# AUTONOMY_NOTIFY_CMD passes a content-blind summary JSON on stdin. Preserve the already-live
# gi#49 behavior: cap the forwarded summary, prefix it for the owner, and send it to Ratatoskr's
# authenticated tailnet-only owner notification endpoint.
set -euo pipefail

ENV_FILE="@@REMOTE_DIR@@/.env"
key=$(grep "^RATATOSKR_SEND_API_KEY=" "$ENV_FILE" | cut -d= -f2-)
chat=$(grep "^RATATOSKR_OWNER_CHAT_ID=" "$ENV_FILE" | cut -d= -f2-)
payload=$(head -c 3000)
text="AUTONOMY[gille]: $payload"

jq -n --arg t "$text" --argjson c "$chat" "{chat_id:\$c,text:\$t}" |
  curl -s -m 10 -X POST \
    -H "Authorization: Bearer $key" \
    -H "content-type: application/json" \
    --data-binary @- \
    http://huginmunin:3034/api/send
