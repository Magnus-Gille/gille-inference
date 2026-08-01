#!/usr/bin/env bash
# Validate the public Cloudflare edge without credentials. cloudflared's origin connection is
# intentionally HTTP, therefore redirects must be configured at the edge, never in gateway.ts.
set -euo pipefail

http_base="${1:-http://inference.example.com}"
https_base="${2:-https://inference.example.com}"
if [[ ! "$http_base" =~ ^http://[^/?#]+/?$ ]]; then
  echo "ERROR: HTTP base must be an origin only (http://host[:port]), with no path, query, or fragment." >&2
  exit 2
fi
if [[ ! "$https_base" =~ ^https://[^/?#]+/?$ ]]; then
  echo "ERROR: HTTPS base must be an origin only (https://host[:port]), with no path, query, or fragment." >&2
  exit 2
fi
http_base="${http_base%/}"
https_base="${https_base%/}"
http_authority="${http_base#http://}"
https_authority="${https_base#https://}"
if [[ "$http_authority" == *"@"* || "$https_authority" == *"@"* ]]; then
  echo "ERROR: public-edge bases must not contain userinfo." >&2
  exit 2
fi
if [ "$(printf '%s' "$http_authority" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$https_authority" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "ERROR: HTTP and HTTPS bases must use the same host and port authority." >&2
  exit 2
fi

headers_for() {
  local method="$1" request_url="$2"
  if [ "$method" = "POST" ]; then
    curl --silent --show-error --max-time 20 --connect-timeout 10 --max-redirs 0 \
      --request POST --data '' --output /dev/null --dump-header - "$request_url"
  else
    curl --silent --show-error --max-time 20 --connect-timeout 10 --max-redirs 0 \
      --request GET --output /dev/null --dump-header - "$request_url"
  fi
}

header_value() {
  local headers="$1" name="$2"
  printf '%s\n' "$headers" | awk -v target="$name" 'BEGIN { IGNORECASE=1 }
    /^[^[:space:]]+:[[:space:]]*/ {
      key=$0; sub(/:.*/, "", key)
      if (tolower(key) == tolower(target)) {
        sub(/^[^:]*:[[:space:]]*/, "")
        gsub(/\r$/, "")
        value=$0
      }
    }
    END { print value }'
}

status_code() {
  printf '%s\n' "$1" | awk '/^HTTP\/[0-9.]+ [0-9]+/ { code=$2 } END { print code }'
}

verify_redirect() {
  local method="$1" path="$2" expected_url headers status location
  expected_url="$https_base$path"
  headers="$(headers_for "$method" "$http_base$path")"
  status="$(status_code "$headers")"
  location="$(header_value "$headers" location)"
  if [[ "$status" != "301" && "$status" != "308" ]]; then
    echo "ERROR: $method $http_base$path returned HTTP ${status:-<none>}, expected one permanent redirect." >&2
    return 1
  fi
  if [ "$location" != "$expected_url" ]; then
    echo "ERROR: $method $http_base$path redirected to '${location:-<none>}', expected '$expected_url'." >&2
    return 1
  fi
  echo "  OK: $method $http_base$path -> $location ($status)"
}

verify_redirect GET "/"
verify_redirect GET "/hs"
verify_redirect POST "/portal/redeem"
verify_redirect GET "/v1/models?probe=public-edge"
verify_redirect GET "/missing?probe=public-edge"

portal_headers="$(headers_for GET "$https_base/portal")"
portal_status="$(status_code "$portal_headers")"
if [[ "$portal_status" -lt 200 || "$portal_status" -ge 300 ]]; then
  echo "ERROR: HTTPS portal returned HTTP ${portal_status:-<none>}, expected a 2xx response." >&2
  exit 1
fi
hsts="$(header_value "$portal_headers" strict-transport-security)"
csp="$(header_value "$portal_headers" content-security-policy)"
xfo="$(header_value "$portal_headers" x-frame-options)"
referrer="$(header_value "$portal_headers" referrer-policy)"
permissions="$(header_value "$portal_headers" permissions-policy)"
hsts_max_age="$(printf '%s\n' "$hsts" | awk '{ line=tolower($0); if (match(line, /max-age[[:space:]]*=[[:space:]]*[0-9]+/)) { value=substr(line, RSTART, RLENGTH); sub(/.*=/, "", value); gsub(/[[:space:]]/, "", value); print value; exit } }')"
[[ "$hsts_max_age" =~ ^[0-9]+$ && "$hsts_max_age" =~ [1-9] ]] || { echo "ERROR: HTTPS portal lacks a positive HSTS max-age." >&2; exit 1; }
[[ "$csp" == *"frame-ancestors 'none'"* ]] || { echo "ERROR: HTTPS portal CSP lacks frame-ancestors 'none'." >&2; exit 1; }
[ "$xfo" = "DENY" ] || { echo "ERROR: HTTPS portal lacks X-Frame-Options: DENY." >&2; exit 1; }
[ "$referrer" = "no-referrer" ] || { echo "ERROR: HTTPS portal lacks Referrer-Policy: no-referrer." >&2; exit 1; }
[ "$permissions" = "geolocation=(), camera=(), microphone=()" ] || { echo "ERROR: HTTPS portal has an unexpected Permissions-Policy." >&2; exit 1; }
echo "  OK: HTTPS portal advertises HSTS and clickjacking/referrer/permissions policies"
