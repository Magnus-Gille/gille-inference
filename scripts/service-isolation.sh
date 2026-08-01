#!/usr/bin/env bash
# Stage the #151 M5 service-account migration.  This script is intentionally
# root-operated and one-service-at-a-time: it never tries to change all three
# production services in one transaction.
set -euo pipefail

readonly ROOT="/var/lib/gille-inference"
readonly ETC="/etc/gille-inference"
readonly GATEWAY_USER="gille-gateway"
readonly TUNNEL_USER="gille-cloudflared"
readonly LLAMA_USER="gille-llama-swap"
readonly GATEWAY_TREE="/home/magnus/home-server-eval"
readonly GATEWAY_DATA="$GATEWAY_TREE/data"
readonly TUNNEL_SOURCE="/home/magnus/.cloudflared"
readonly LLAMA_TREE="/home/magnus/llama-swap"
readonly LLAMA_MODELS="/home/magnus/models"
readonly LLAMA_RUNTIME="/home/magnus/llama.cpp"
readonly LLAMA_GPU_RENDER_DEVICE="${LLAMA_GPU_RENDER_DEVICE:-/dev/dri/renderD128}"
readonly LLAMA_GPU_CARD_DEVICE="${LLAMA_GPU_CARD_DEVICE:-/dev/dri/card0}"
readonly GATEWAY_ISOLATION_MARKER="$ROOT/gateway/isolation-marker"
gateway_home() { printf '%s\n' "$ROOT/$GATEWAY_USER"; }

usage() {
  cat <<'EOF'
Usage: scripts/service-isolation.sh <render|preflight|apply|verify|rollback|refresh-autonomy> --service <gateway|cloudflared|llama-swap> [options]

No command accepts "all": migrate, verify, and roll back exactly one service
at a time. `apply` and `rollback` require root and an explicit acknowledgement.

Commands:
  render     Write a reviewable drop-in to --output-dir (no host mutation).
  preflight  Read-only checks of the live unit, source paths, identities, and prerequisites.
  apply      Back up one service, migrate its minimum state/secret material, install its drop-in,
             restart it, and verify its local contract. Requires --ack-service-restart.
  verify     Read-only post-migration identity, sandbox, path, and listener checks.
  rollback   Restore the most recent recorded backup for one service. Requires --ack-rollback.
  refresh-autonomy  Re-render the isolated gateway autonomy hook/unit after a source deploy (root-only).

Options:
  --service NAME       gateway | cloudflared | llama-swap (required)
  --output-dir PATH    render destination (default: current directory)
  --backup-dir PATH    apply/rollback evidence root (default: /var/lib/gille-inference/isolation-backups)
  --ack-service-restart  required for apply
  --ack-rollback         required for rollback

The script deliberately never prints .env files, Cloudflare credentials, key
material, or application data. See deploy/README.md's service-isolation section
for the owner-attended rollout, evidence, and rollback procedure.
EOF
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command missing: $1"; }
root_only() { [ "$(id -u)" -eq 0 ] || die "this command must run as root (use sudo)"; }
unit_for() {
  case "$1" in
    gateway) printf '%s\n' home-gateway.service ;;
    cloudflared) printf '%s\n' cloudflared.service ;;
    llama-swap) printf '%s\n' llama-swap.service ;;
    *) die "unknown service '$1'; choose gateway, cloudflared, or llama-swap" ;;
  esac
}
user_for() {
  case "$1" in
    gateway) printf '%s\n' "$GATEWAY_USER" ;;
    cloudflared) printf '%s\n' "$TUNNEL_USER" ;;
    llama-swap) printf '%s\n' "$LLAMA_USER" ;;
    *) die "unknown service '$1'" ;;
  esac
}
require_mode() {
  local path="$1" want="$2" actual
  actual="$(stat -c '%a' "$path")"
  [ "$actual" = "$want" ] || die "$path mode is $actual, expected $want"
}
require_owner_group() {
  local path="$1" owner="$2" group="$3" actual
  actual="$(stat -c '%U:%G' "$path")"
  [ "$actual" = "$owner:$group" ] || die "$path owner/group is $actual, expected $owner:$group"
}
is_empty_or_missing() { [ ! -e "$1" ] || [ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; }

validate_service_identity() {
  local user="$1" service="$2" uid home shell primary groups expected sudo_output
  uid="$(id -u "$user")"; home="$(getent passwd "$user" | awk -F: '{print $6}')"; shell="$(getent passwd "$user" | awk -F: '{print $7}')"; primary="$(id -gn "$user")"
  [ "$uid" -lt 1000 ] || die "$user has non-system UID $uid; refuse to repurpose an interactive identity"
  [ "$home" = "$ROOT/$user" ] || die "$user home is $home, expected $ROOT/$user"
  { [ "$shell" = /usr/sbin/nologin ] || [ "$shell" = /bin/false ]; } || die "$user has login shell $shell"
  [ "$primary" = "$user" ] || die "$user primary group is $primary, expected $user"
  groups="$(id -nG "$user" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')"
  expected="$user"
  [ "$groups" = "$expected" ] || die "$user groups are '$groups', expected '$expected'"
  # `sudo -l -U` returns success even for "is not allowed", so exit status is
  # not authorization evidence. Force C output and accept only that exact denial.
  sudo_output="$(LC_ALL=C sudo -n -l -U "$user" 2>&1 || true)"
  sudo_output_is_nonprivileged "$sudo_output" || die "$user has sudo authority or an unrecognised sudo policy result"
  [ "$(stat -c '%U:%G:%a' "$home")" = "$user:$user:700" ] || die "$user home must be owned $user:$user mode 0700"
  ! runuser -u "$user" -- test -x /home/magnus || die "$user can traverse /home/magnus outside reviewed unit binds"
}

sudo_output_is_nonprivileged() {
  case "$1" in
    *"is not allowed to run sudo"*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_source_path() {
  local path="$1" label="$2" mode owner group
  owner="$(stat -c '%U' "$path")"; group="$(stat -c '%G' "$path")"; mode="$(stat -c '%a' "$path")"
  { [ "$owner" = magnus ] || [ "$owner" = root ]; } || die "$label is owned by $owner, expected magnus or root"
  { [ "$group" = magnus ] || [ "$group" = root ]; } || die "$label group is $group, expected magnus or root"
  # Magnus-owned source directories legitimately need group traversal/write
  # during normal service operation. World write is never acceptable; a foreign
  # group is rejected above, so a retained Magnus group-write bit is authorized.
  [ $((8#$mode & 0002)) -eq 0 ] || die "$label is world-writable; refuse mutable owner input"
  if [ -d "$path" ]; then
    [ $((8#$mode & 0100)) -ne 0 ] || die "$label directory is not owner-traversable"
  fi
}

render_common() {
  cat <<'EOF'
# Generated by scripts/service-isolation.sh; do not hand-edit.
# Review the source template and re-render it during an owner-attended migration.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=tmpfs
PrivateTmp=true
PrivateMounts=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectClock=true
LockPersonality=true
RestrictSUIDSGID=true
RemoveIPC=true
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
EOF
}

render_dropin() {
  local service="$1"
  printf '[Service]\n'
  case "$service" in
    gateway)
      cat <<EOF
User=$GATEWAY_USER
Group=$GATEWAY_USER
EnvironmentFile=$ETC/gateway/gateway.env
Environment=AUTONOMY_NOTIFY_CMD=$ROOT/gateway/bin/autonomy-notify.sh
Environment=GILLE_AUTONOMY_ENV_FILE=$ETC/gateway/gateway.env
Environment=HOMESERVER_CODE_LOOP_WORKROOT=$ROOT/gateway/data/code-loop-work
Environment=HOMESERVER_CODE_LOOP_PI_BIN=$ROOT/$GATEWAY_USER/.local/bin/pi
Environment=HOMESERVER_CODE_LOOP_PI_AGENT_DIR=$ROOT/$GATEWAY_USER/.pi-code-loop
BindReadOnlyPaths=$GATEWAY_TREE
BindPaths=$ROOT/gateway/data:$GATEWAY_DATA
ReadOnlyPaths=$GATEWAY_TREE
InaccessiblePaths=-$GATEWAY_TREE/.claude
InaccessiblePaths=-$GATEWAY_TREE/.codex
InaccessiblePaths=-$GATEWAY_TREE/.ssh
InaccessiblePaths=-$GATEWAY_TREE/.git
InaccessiblePaths=-$GATEWAY_TREE/.pi-code-loop
ReadWritePaths=$ROOT/gateway/data
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
PrivateDevices=true
EOF
      render_common
      ;;
    cloudflared)
      cat <<EOF
User=$TUNNEL_USER
Group=$TUNNEL_USER
ExecStart=
ExecStart=/usr/bin/cloudflared --config $ETC/cloudflared/config.yml --no-autoupdate tunnel run m5-inference
ReadOnlyPaths=$ETC/cloudflared
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
PrivateDevices=true
MemoryDenyWriteExecute=true
EOF
      render_common
      ;;
    llama-swap)
      cat <<EOF
User=$LLAMA_USER
Group=$LLAMA_USER
SupplementaryGroups=render video
ExecStart=
ExecStart=$LLAMA_TREE/llama-swap --config $ETC/llama-swap/config.yaml --listen 127.0.0.1:8091
BindReadOnlyPaths=$LLAMA_TREE
BindReadOnlyPaths=$LLAMA_MODELS
BindReadOnlyPaths=$LLAMA_RUNTIME
ReadOnlyPaths=$ETC/llama-swap
ReadWritePaths=$ROOT/llama-swap
PrivateDevices=false
DevicePolicy=closed
DeviceAllow=/dev/null rw
DeviceAllow=/dev/urandom r
DeviceAllow=/dev/random r
DeviceAllow=$LLAMA_GPU_RENDER_DEVICE rw
DeviceAllow=$LLAMA_GPU_CARD_DEVICE rw
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
IPAddressAllow=::1/128
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
EOF
      render_common
      ;;
  esac
}

render() {
  local output_dir="$1" service="$2"
  mkdir -p "$output_dir"
  render_dropin "$service" >"$output_dir/$service.conf"
  note "Rendered $output_dir/$service.conf"
}

render_gateway_autonomy_service() {
  cat <<EOF
[Unit]
Description=Gille autonomy tick (isolated gateway identity)
After=home-gateway.service
Requires=home-gateway.service

[Service]
Type=oneshot
User=$GATEWAY_USER
Group=$GATEWAY_USER
WorkingDirectory=$GATEWAY_TREE
EnvironmentFile=$ETC/gateway/gateway.env
Environment=AUTONOMY_NOTIFY_CMD=$ROOT/gateway/bin/autonomy-notify.sh
Environment=GILLE_AUTONOMY_ENV_FILE=$ETC/gateway/gateway.env
Environment=HOMESERVER_CODE_LOOP_WORKROOT=$ROOT/gateway/data/code-loop-work
ExecStart=$GATEWAY_TREE/node_modules/.bin/tsx scripts/autonomy-tick-cli.ts
BindReadOnlyPaths=$GATEWAY_TREE
BindPaths=$ROOT/gateway/data:$GATEWAY_DATA
ReadOnlyPaths=$GATEWAY_TREE
InaccessiblePaths=-$GATEWAY_TREE/.claude
InaccessiblePaths=-$GATEWAY_TREE/.codex
InaccessiblePaths=-$GATEWAY_TREE/.ssh
InaccessiblePaths=-$GATEWAY_TREE/.git
InaccessiblePaths=-$GATEWAY_TREE/.pi-code-loop
ReadWritePaths=$ROOT/gateway/data
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
PrivateDevices=true
EOF
  render_common
}

render_gateway_autonomy_timer() {
  cat <<'EOF'
[Unit]
Description=Daily Gille autonomy tick (isolated gateway identity)

[Timer]
OnCalendar=*-*-* 05:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

show_value() { systemctl show "$1" -p "$2" --value; }
require_show_contains() {
  local unit="$1" property="$2" expected="$3" value
  value="$(show_value "$unit" "$property")"
  [[ "$value" == *"$expected"* ]] || die "$unit effective $property does not contain the reviewed isolation constraint"
}
require_show_empty() {
  local unit="$1" property="$2"
  [ -z "$(show_value "$unit" "$property")" ] || die "$unit effective $property is not empty"
}
normalize_show_set() {
  # systemd presents list-valued properties as whitespace-separated tokens.
  # A same-source/destination bind is serialized as `/path:/path:rbind`; it
  # is equivalent to the reviewed `/path` shorthand. Non-identity binds keep
  # both sides so an unexpected destination cannot be normalized away.
  tr '[:space:]' '\n' | awk '
    /^\/[^:]+:\/[^:]+:rbind$/ {
      split($0, parts, ":")
      if (parts[1] == parts[2]) { print parts[1]; next }
    }
    { value = $0; sub(/:(rbind|rw)$/, "", value); if (value != "") print value }
  ' | sort -u
}
require_show_exact_set() {
  local unit="$1" property="$2" actual expected
  shift 2
  actual="$(show_value "$unit" "$property" | normalize_show_set)"
  expected="$(printf '%s\n' "$@" | normalize_show_set)"
  [ "$actual" = "$expected" ] || die "$unit effective $property differs from the reviewed allowlist"
}
require_show_exact_device_allow() {
  local unit="$1" actual expected
  shift
  # systemctl show emits DeviceAllow as whitespace-separated path/access pairs.
  actual="$(show_value "$unit" DeviceAllow | awk '{ for (i = 1; i <= NF; i += 2) { if (i + 1 > NF) exit 1; print $i ":" $(i + 1) } }' | sort -u)" || die "$unit DeviceAllow has an unparseable effective form"
  expected="$(printf '%s\n' "$@" | sort -u)"
  [ "$actual" = "$expected" ] || die "$unit effective DeviceAllow differs from the reviewed allowlist"
}
assert_unit_prerequisites() {
  local service="$1" unit user actual_user fragment execstart
  unit="$(unit_for "$service")"; user="$(user_for "$service")"
  [ "$(show_value "$unit" LoadState)" = loaded ] || die "$unit is not loaded"
  [ "$(show_value "$unit" ActiveState)" = active ] || die "$unit is not active; recover it before migration"
  actual_user="$(show_value "$unit" User)"
  [ "$actual_user" = magnus ] || [ "$actual_user" = "$user" ] || die "$unit User is '$actual_user', expected magnus or $user"
  fragment="$(show_value "$unit" FragmentPath)"
  [ "$fragment" = "/etc/systemd/system/$unit" ] || die "$unit fragment is not the expected owner-managed unit"
  execstart="$(show_value "$unit" ExecStart)"
  case "$service" in
    gateway)
      [ "$(show_value "$unit" WorkingDirectory)" = "$GATEWAY_TREE" ] || die "gateway WorkingDirectory differs from the reviewed migration source"
      [[ "$execstart" == *"$GATEWAY_TREE/node_modules/.bin/tsx"* ]] || die "gateway ExecStart differs from the reviewed migration source"
      [ -f "$GATEWAY_TREE/.env" ] || die "gateway .env is absent; do not infer a replacement"
      [ -d "$GATEWAY_DATA" ] || die "gateway data directory is absent; do not infer state"
      validate_source_path "$GATEWAY_TREE/.env" "gateway environment"
      validate_source_path "$GATEWAY_DATA" "gateway state directory"
      ;;
    cloudflared)
      [[ "$execstart" == *"/usr/bin/cloudflared"*"$TUNNEL_SOURCE/config.yml"* ]] || die "cloudflared ExecStart differs from the reviewed migration source"
      [ -f "$TUNNEL_SOURCE/config.yml" ] || die "cloudflared config is absent"
      validate_source_path "$TUNNEL_SOURCE" "cloudflared source directory"
      validate_source_path "$TUNNEL_SOURCE/config.yml" "cloudflared config"
      ;;
    llama-swap)
      [[ "$execstart" == *"$LLAMA_TREE/llama-swap"*"$LLAMA_TREE/config.yaml"*"127.0.0.1:8091"* ]] || die "llama-swap ExecStart differs from the reviewed migration source"
      [ -x "$LLAMA_TREE/llama-swap" ] || die "llama-swap executable is absent or not executable"
      [ -f "$LLAMA_TREE/config.yaml" ] || die "llama-swap config is absent"
      validate_source_path "$LLAMA_TREE/config.yaml" "llama-swap config"
      [ -d "$LLAMA_MODELS" ] || die "llama model tree is absent"
      [ -d "$LLAMA_RUNTIME" ] || die "llama runtime tree is absent"
      getent group render >/dev/null || die "render group is absent; cannot grant GPU render access safely"
      getent group video >/dev/null || die "video group is absent; cannot grant GPU video access safely"
      [ -c "$LLAMA_GPU_RENDER_DEVICE" ] || die "configured render device is absent: $LLAMA_GPU_RENDER_DEVICE"
      [ -c "$LLAMA_GPU_CARD_DEVICE" ] || die "configured card device is absent: $LLAMA_GPU_CARD_DEVICE"
      ;;
  esac
}

preflight() {
  local service="$1" unit user
  need systemctl; need getent; need stat
  unit="$(unit_for "$service")"; user="$(user_for "$service")"
  if [ "$(show_value "$unit" User)" = "$user" ]; then
    verify "$service"
    note "PASS: $service is already isolated; preflight is a verified no-op"
    return 0
  fi
  assert_unit_prerequisites "$service"
  [ ! -e "/etc/systemd/system/$unit.d/50-service-isolation.conf" ] || die "$unit already has an isolation drop-in; inspect it rather than overwriting administrator state"
  if id "$user" >/dev/null 2>&1; then
    validate_service_identity "$user" "$service"
    note "PASS: $unit is eligible for migration to existing $user"
  else
    note "PASS: $unit is eligible; $user will be created by apply"
  fi
  case "$service" in
    gateway)
      for isolated_unit in /etc/systemd/system/gille-autonomy-tick.service /etc/systemd/system/gille-autonomy-tick.timer; do
        [ ! -e "$isolated_unit" ] || die "$isolated_unit already exists; refuse to overwrite system-scope administrator state"
      done
      local magnus_uid active_scopes autonomy_state
      magnus_uid="$(id -u magnus)"
      active_scopes="$(runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$magnus_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$magnus_uid/bus" systemctl --user list-units 'code-loop-*.scope' --state=active --no-legend --plain)" || die "could not query Magnus code-loop scopes; refusing to migrate while drain state is unknown"
      [ -z "$active_scopes" ] || die "active Magnus code-loop scope exists; drain it before migrating durable work state"
      autonomy_state="$(runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$magnus_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$magnus_uid/bus" systemctl --user show gille-autonomy-tick.service -p ActiveState --value)" || die "could not query Magnus autonomy tick state; refusing to migrate while drain state is unknown"
      case "$autonomy_state" in inactive|failed) ;; *) die "Magnus autonomy tick state is $autonomy_state; wait for it to finish before migrating state" ;; esac
      if [ -e "$ROOT/gateway/data" ] && ! is_empty_or_missing "$ROOT/gateway/data"; then
        die "$ROOT/gateway/data already contains state; inspect/restore before applying"
      fi
      ;;
    cloudflared)
      if [ -e "$ETC/cloudflared" ] && ! is_empty_or_missing "$ETC/cloudflared"; then
        die "$ETC/cloudflared already contains configuration; inspect/restore before applying"
      fi
      ;;
    llama-swap)
      if [ -e "$ETC/llama-swap/config.yaml" ]; then
        die "$ETC/llama-swap/config.yaml already exists; inspect/restore before applying"
      fi
      ;;
  esac
  note "PASS: preflight completed for $service (read-only)"
}

create_service_user() {
  local user="$1" service="$2"
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$ROOT/$user" --create-home --shell /usr/sbin/nologin "$user"
  fi
  install -d -m 0700 -o "$user" -g "$user" "$ROOT/$user"
  validate_service_identity "$user" "$service"
}

gateway_env_file() {
  if [ -f "$ETC/gateway/gateway.env" ]; then printf '%s\n' "$ETC/gateway/gateway.env"; else printf '%s\n' "$GATEWAY_TREE/.env"; fi
}

gateway_codeloop_enabled() {
  # Read only this boolean, never source the environment file or print its contents.
  awk -F= '$1 == "HOMESERVER_CODE_LOOP" { v=$2 } END { exit !(v == "on") }' "$(gateway_env_file)"
}

gateway_codeloop_source_dir() {
  # The path is operational metadata, not emitted. The ownership/mode checks below are the only
  # observable result. A missing explicit setting is fail-closed while code_loop is enabled.
  awk -F= '$1 == "HOMESERVER_CODE_LOOP_PI_AGENT_DIR" { print substr($0, index($0, "=") + 1); exit }' "$(gateway_env_file)"
}

gateway_codeloop_source_pi() {
  awk -F= '$1 == "HOMESERVER_CODE_LOOP_PI_BIN" { print substr($0, index($0, "=") + 1); exit }' "$(gateway_env_file)"
}

gateway_health_url() {
  local env host port
  env="$(gateway_env_file)"
  host="$(awk -F= '$1 == "HOMESERVER_HOST" { print substr($0, index($0, "=") + 1); exit }' "$env")"
  port="$(awk -F= '$1 == "HOMESERVER_PORT" { print substr($0, index($0, "=") + 1); exit }' "$env")"
  [[ "$host" =~ ^[0-9A-Fa-f:.]+$ ]] || die "gateway host is absent or not an IP literal; refusing to guess a health locator"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || die "gateway port is absent or invalid"
  if [[ "$host" == *:* ]]; then
    printf 'http://[%s]:%s/healthz\n' "$host" "$port"
  else
    printf 'http://%s:%s/healthz\n' "$host" "$port"
  fi
}

prepare_gateway_user_manager() {
  local uid
  uid="$(id -u "$GATEWAY_USER")"
  loginctl enable-linger "$GATEWAY_USER"
  [ "$(loginctl show-user "$GATEWAY_USER" -p Linger --value)" = yes ] || die "could not enable lingering for $GATEWAY_USER"
  # The gateway's code_loop uses systemd-run --user. Its child process derives these exact
  # pointers from its service UID; without a durable user manager it would regress after reboot.
  [ -S "/run/user/$uid/bus" ] || die "gille-gateway user bus is absent after enabling linger"
  runuser -u "$GATEWAY_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-active default.target >/dev/null \
    || die "gille-gateway user manager is not usable for code_loop"
}

provision_gateway_codeloop_runtime() {
  local home source_pi source_agent version
  gateway_codeloop_enabled || return 0
  home="$(gateway_home)"
  source_pi="$(gateway_codeloop_source_pi)"
  source_agent="$(gateway_codeloop_source_dir)"
  [ -n "$source_pi" ] && [ -x "$source_pi" ] || die "code_loop is enabled but HOMESERVER_CODE_LOOP_PI_BIN is not an executable"
  [ -n "$source_agent" ] && [ -f "$source_agent/models.json" ] || die "code_loop is enabled but its models.json is absent"
  version="$($source_pi --version 2>/dev/null | head -n 1 | tr -cd '0-9.')"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not derive a safe pinned Pi version from the existing runtime"
  install -d -m 0700 -o "$GATEWAY_USER" -g "$GATEWAY_USER" "$home/.pi-code-loop"
  # A dedicated pinned Pi runtime; do not copy the owner's ~/.local tree or auth.json.
  runuser -u "$GATEWAY_USER" -- env HOME="$home" NPM_CONFIG_PREFIX="$home/.local" npm install --global "@mariozechner/pi-coding-agent@$version" >/dev/null
  install -m 0600 -o "$GATEWAY_USER" -g "$GATEWAY_USER" "$source_agent/models.json" "$home/.pi-code-loop/models.json"
  [ -x "$home/.local/bin/pi" ] || die "dedicated Pi runtime was not installed"
  [ -f "$home/.pi-code-loop/models.json" ] || die "dedicated Pi models.json was not installed"
  [ ! -e "$home/.pi-code-loop/auth.json" ] || die "refusing to proceed: dedicated Pi runtime contains auth.json"
}

backup_unit() {
  local service="$1" unit="$2" backup="$3"
  mkdir -p "$backup"
  systemctl cat "$unit" >"$backup/unit.before.txt"
  systemctl show "$unit" -p User -p Group -p ExecStart -p WorkingDirectory -p DropInPaths --no-pager >"$backup/unit.before.show"
  render_dropin "$service" >"$backup/rendered-dropin.conf"
  if [ "$service" = gateway ]; then
    local uid
    uid="$(id -u magnus)"
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-enabled gille-autonomy-tick.timer >"$backup/legacy-timer.enabled" 2>&1 || true
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-active gille-autonomy-tick.timer >"$backup/legacy-timer.active" 2>&1 || true
    stat -c '%a' "$GATEWAY_DATA" >"$backup/gateway-data.mode"
    for isolated_unit in /etc/systemd/system/gille-autonomy-tick.service /etc/systemd/system/gille-autonomy-tick.timer; do
      [ ! -e "$isolated_unit" ] || die "$isolated_unit appeared after preflight; refusing to overwrite it"
    done
  fi
}

migrate_gateway_state() {
  install -d -m 0750 -o root -g "$GATEWAY_USER" "$ROOT/gateway"
  # Refuse a merge: preserving two divergent SQLite trees would make rollback ambiguous.
  is_empty_or_missing "$ROOT/gateway/data" || die "gateway target state is not empty"
  [ ! -d "$ROOT/gateway/data" ] || rmdir "$ROOT/gateway/data"
  install -d -m 0755 -o root -g root "$ETC"
  install -d -m 0750 -o root -g "$GATEWAY_USER" "$ETC/gateway"
  # Copy the replacement secret before moving state. If anything fails after the
  # atomic state rename, rollback has every artifact it needs to restore the old
  # service without guessing or manufacturing credentials.
  install -m 0640 -o root -g "$GATEWAY_USER" "$GATEWAY_TREE/.env" "$ETC/gateway/gateway.env"
  systemctl stop home-gateway.service
  mv "$GATEWAY_DATA" "$ROOT/gateway/data"
  install -d -m 0755 -o root -g root "$GATEWAY_DATA"
  chown -R "$GATEWAY_USER:$GATEWAY_USER" "$ROOT/gateway/data"
  chmod 0700 "$ROOT/gateway/data"
  rm "$GATEWAY_TREE/.env"
}

legacy_timer_was_enabled() { grep -qx 'enabled\|enabled-runtime' "$1/legacy-timer.enabled"; }
legacy_timer_was_active() { grep -qx active "$1/legacy-timer.active"; }

restore_legacy_autonomy_timer() {
  local backup="$1" uid
  uid="$(id -u magnus)"
  if legacy_timer_was_enabled "$backup"; then
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user enable gille-autonomy-tick.timer || die "legacy autonomy timer could not be re-enabled"
  else
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user disable gille-autonomy-tick.timer || die "legacy autonomy timer could not be disabled"
  fi
  if legacy_timer_was_active "$backup"; then
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user start gille-autonomy-tick.timer || die "legacy autonomy timer could not be restarted"
  else
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user stop gille-autonomy-tick.timer || die "legacy autonomy timer could not be stopped"
  fi
  assert_legacy_autonomy_timer_state "$backup"
}

assert_legacy_autonomy_timer_state() {
  local backup="$1" uid
  uid="$(id -u magnus)"
  if legacy_timer_was_enabled "$backup"; then
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-enabled --quiet gille-autonomy-tick.timer || die "legacy autonomy enabled state mismatch after rollback"
  else
    ! runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-enabled --quiet gille-autonomy-tick.timer || die "legacy autonomy enabled state mismatch after rollback"
  fi
  if legacy_timer_was_active "$backup"; then
    runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-active --quiet gille-autonomy-tick.timer || die "legacy autonomy active state mismatch after rollback"
  else
    ! runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-active --quiet gille-autonomy-tick.timer || die "legacy autonomy active state mismatch after rollback"
  fi
}

cleanup_gateway_partial_secret() {
  # Preflight requires this directory to be empty. This only removes a copied
  # replacement when the legacy source remains, so it cannot erase migrated state.
  if [ -f "$GATEWAY_TREE/.env" ] && [ -f "$ETC/gateway/gateway.env" ] && [ ! -d "$ROOT/gateway/data" ]; then
    rm -f "$ETC/gateway/gateway.env"
    rmdir "$ETC/gateway" 2>/dev/null || true
  fi
}

apply_exit_handler() {
  local status="$1"
  [ "$status" -ne 0 ] || return 0
  [ "${GATEWAY_APPLY_INFLIGHT:-0}" = 1 ] || return 0
  trap - EXIT
  note "Gateway migration interrupted; restoring the captured legacy timer state."
  # Same-device state moves are atomic. Once state is present, normal rollback
  # owns the complete restoration; before then only a copied secret can exist.
  if [ -d "$ROOT/gateway/data" ] && [ -f "$ETC/gateway/gateway.env" ]; then
    if ! rollback gateway "$APPLY_BACKUP"; then
      note "Automatic gateway rollback failed; legacy timer restoration is still being attempted. Backup evidence: $APPLY_BACKUP"
      restore_legacy_autonomy_timer "$APPLY_BACKUP" || true
    fi
  else
    cleanup_gateway_partial_secret
    restore_legacy_autonomy_timer "$APPLY_BACKUP" || true
    if ! systemctl is-active --quiet home-gateway.service; then
      systemctl start home-gateway.service || note "Legacy gateway could not be restarted automatically; inspect $APPLY_BACKUP"
    fi
  fi
  exit "$status"
}

rollback_feasible() {
  local service="$1"
  case "$service" in
    gateway)
      [ -d "$ROOT/gateway/data" ] || die "gateway migration state is absent; refusing ambiguous rollback"
      is_empty_or_missing "$GATEWAY_DATA" || die "gateway original data path is not empty; refusing merge"
      [ -f "$ETC/gateway/gateway.env" ] || die "gateway migrated env is absent"
      ;;
    cloudflared)
      [ -d "$ETC/cloudflared" ] || die "cloudflared migrated directory is absent"
      [ ! -e "$TUNNEL_SOURCE" ] || die "cloudflared original path exists; refusing merge"
      ;;
    llama-swap)
      [ -f "$ETC/llama-swap/config.yaml" ] || die "migrated llama-swap config is absent; refusing rollback"
      [ ! -e "$LLAMA_TREE/config.yaml" ] || die "legacy llama-swap config already exists; refusing merge"
      ;;
  esac
}

require_atomic_move() {
  local source="$1" target_parent="$2" source_device target_device
  source_device="$(stat -c %d "$source")"
  target_device="$(stat -c %d "$target_parent")"
  [ "$source_device" = "$target_device" ] || die "$source and $target_parent are on different filesystems; refusing non-atomic migration"
}

disable_legacy_autonomy_timer() {
  local uid
  uid="$(id -u magnus)"
  runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user disable --now gille-autonomy-tick.timer
  ! runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-active --quiet gille-autonomy-tick.timer || die "legacy autonomy timer stayed active"
  ! runuser -u magnus -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-enabled --quiet gille-autonomy-tick.timer || die "legacy autonomy timer stayed enabled"
}

install_gateway_autonomy_timer() {
  install -d -m 0750 -o root -g "$GATEWAY_USER" "$ROOT/gateway/bin"
  local hook_tmp
  hook_tmp="$(mktemp "$ROOT/gateway/bin/.autonomy-notify.sh.XXXXXX")"
  sed "s|@@REMOTE_DIR@@|$GATEWAY_TREE|g" "$GATEWAY_TREE/deploy/autonomy-notify.sh" >"$hook_tmp"
  chown root:"$GATEWAY_USER" "$hook_tmp"
  chmod 0750 "$hook_tmp"
  mv "$hook_tmp" "$ROOT/gateway/bin/autonomy-notify.sh"
  chown root:"$GATEWAY_USER" "$ROOT/gateway/bin/autonomy-notify.sh"
  chmod 0750 "$ROOT/gateway/bin/autonomy-notify.sh"
  install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/gille-autonomy-tick.service < <(render_gateway_autonomy_service)
  install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/gille-autonomy-tick.timer < <(render_gateway_autonomy_timer)
  systemctl daemon-reload
  systemctl enable --now gille-autonomy-tick.timer
  systemctl is-active --quiet gille-autonomy-tick.timer || die "isolated autonomy timer did not start"
}

migrate_tunnel_state() {
  install -d -m 0755 -o root -g root "$ETC"
  is_empty_or_missing "$ETC/cloudflared" || die "cloudflared target is not empty"
  systemctl stop cloudflared.service
  mv "$TUNNEL_SOURCE" "$ETC/cloudflared"
  # cloudflared needs to read, not alter, its tunnel credential. Root ownership stops a
  # compromised network-facing daemon from replacing its own credential/config.
  chown -R "root:$TUNNEL_USER" "$ETC/cloudflared"
  find "$ETC/cloudflared" -type d -exec chmod 0750 {} +
  find "$ETC/cloudflared" -type f -exec chmod 0640 {} +
  # The reviewed source config pointed at the old directory. Do not accept a partial rewrite.
  grep -Fq "$TUNNEL_SOURCE" "$ETC/cloudflared/config.yml" || die "cloudflared config does not reference the expected old root; refusing unsafe rewrite"
  sed -i "s|$TUNNEL_SOURCE|$ETC/cloudflared|g" "$ETC/cloudflared/config.yml"
  ! grep -Fq "$TUNNEL_SOURCE" "$ETC/cloudflared/config.yml" || die "cloudflared source-root rewrite was incomplete"
}

migrate_llama_state() {
  install -d -m 0750 -o root -g "$LLAMA_USER" "$ETC/llama-swap"
  [ ! -e "$ETC/llama-swap/config.yaml" ] || die "llama-swap target config already exists"
  systemctl stop llama-swap.service
  mv "$LLAMA_TREE/config.yaml" "$ETC/llama-swap/config.yaml"
  chown root:"$LLAMA_USER" "$ETC/llama-swap/config.yaml"
  chmod 0640 "$ETC/llama-swap/config.yaml"
  install -d -m 0750 -o "$LLAMA_USER" -g "$LLAMA_USER" "$ROOT/llama-swap"
}

install_dropin() {
  local service="$1" unit dir
  unit="$(unit_for "$service")"; dir="/etc/systemd/system/$unit.d"
  install -d -m 0755 -o root -g root "$dir"
  render_dropin "$service" >"$dir/50-service-isolation.conf"
  chmod 0644 "$dir/50-service-isolation.conf"
  systemctl daemon-reload
}

verify() {
  local service="$1" require_marker="${2:-1}" unit user actual_user
  need systemctl; need ss
  unit="$(unit_for "$service")"; user="$(user_for "$service")"
  actual_user="$(show_value "$unit" User)"
  [ "$actual_user" = "$user" ] || die "$unit still runs as '$actual_user', expected '$user'"
  validate_service_identity "$user" "$service"
  for prop in NoNewPrivileges ProtectSystem ProtectHome PrivateTmp; do
    case "$(show_value "$unit" "$prop")" in yes|true|strict|tmpfs) ;; *) die "$unit has unsafe $prop=$(show_value "$unit" "$prop")" ;; esac
  done
  [ "$(show_value "$unit" UMask)" = 0077 ] || die "$unit UMask is not 0077"
  require_show_empty "$unit" CapabilityBoundingSet
  require_show_empty "$unit" AmbientCapabilities
  require_show_exact_set "$unit" RestrictAddressFamilies AF_UNIX AF_INET AF_INET6
  case "$service" in
    gateway)
      require_mode "$ROOT/gateway" 750
      require_owner_group "$ROOT/gateway" root "$GATEWAY_USER"
      if [ ! -f "$ETC/gateway/gateway.env" ]; then
        die "gateway env was not moved"
      fi
      require_mode "$ETC/gateway/gateway.env" 640
      require_owner_group "$ETC/gateway/gateway.env" root "$GATEWAY_USER"
      if [ "$require_marker" = 1 ]; then
        if [ ! -f "$GATEWAY_ISOLATION_MARKER" ]; then
          die "gateway isolation marker is absent or unsafe"
        fi
        require_mode "$GATEWAY_ISOLATION_MARKER" 600
        require_owner_group "$GATEWAY_ISOLATION_MARKER" root root
      fi
      [ ! -e "$GATEWAY_TREE/.env" ] || die "gateway source .env remains in owner home"
      require_mode "$ROOT/gateway/data" 700
      require_owner_group "$ROOT/gateway/data" "$GATEWAY_USER" "$GATEWAY_USER"
      if gateway_codeloop_enabled; then
        [ -d "$ROOT/gateway/data/code-loop-work" ] || die "gateway code-loop work state was not preserved"
        require_owner_group "$ROOT/gateway/data/code-loop-work" "$GATEWAY_USER" "$GATEWAY_USER"
      fi
      require_mode "$ROOT/gateway/bin" 750
      require_owner_group "$ROOT/gateway/bin" root "$GATEWAY_USER"
      require_mode "$ROOT/gateway/bin/autonomy-notify.sh" 750
      require_owner_group "$ROOT/gateway/bin/autonomy-notify.sh" root "$GATEWAY_USER"
      [ "$(show_value "$unit" PrivateDevices)" = yes ] || die "$unit PrivateDevices is not enabled"
      require_show_exact_set "$unit" BindReadOnlyPaths "$GATEWAY_TREE"
      require_show_exact_set "$unit" BindPaths "$ROOT/gateway/data:$GATEWAY_DATA"
      require_show_exact_set "$unit" ReadWritePaths "$ROOT/gateway/data"
      require_show_exact_set "$unit" InaccessiblePaths "-$GATEWAY_TREE/.claude" "-$GATEWAY_TREE/.codex" "-$GATEWAY_TREE/.ssh" "-$GATEWAY_TREE/.git" "-$GATEWAY_TREE/.pi-code-loop"
      if gateway_codeloop_enabled; then
        local home uid
        home="$(gateway_home)"; uid="$(id -u "$GATEWAY_USER")"
        [ "$(loginctl show-user "$GATEWAY_USER" -p Linger --value)" = yes ] || die "gille-gateway lingering is disabled"
        [ -S "/run/user/$uid/bus" ] || die "gille-gateway user bus is absent"
        [ -x "$home/.local/bin/pi" ] || die "dedicated Pi binary is absent"
        [ -f "$home/.pi-code-loop/models.json" ] || die "dedicated Pi models.json is absent"
        [ ! -e "$home/.pi-code-loop/auth.json" ] || die "dedicated Pi runtime must not hold auth.json"
      fi
      systemctl is-active --quiet "$unit" || die "$unit is not active"
      curl --fail --silent --show-error --max-time 5 "$(gateway_health_url)" >/dev/null || die "gateway configured-listener health failed"
      systemctl is-active --quiet gille-autonomy-tick.timer || die "isolated autonomy timer is not active"
      ;;
    cloudflared)
      if [ ! -d "$ETC/cloudflared" ]; then
        die "cloudflared secret directory was not moved"
      fi
      require_mode "$ETC/cloudflared" 750
      require_owner_group "$ETC/cloudflared" root "$TUNNEL_USER"
      [ "$(show_value "$unit" PrivateDevices)" = yes ] || die "$unit PrivateDevices is not enabled"
      require_show_exact_set "$unit" ReadOnlyPaths "$ETC/cloudflared"
      require_show_empty "$unit" ReadWritePaths
      require_show_empty "$unit" BindPaths
      require_show_empty "$unit" BindReadOnlyPaths
      find "$ETC/cloudflared" -type d ! -perm 0750 -print -quit | grep -q . && die "cloudflared directory mode drift"
      find "$ETC/cloudflared" -type f ! -perm 0640 -print -quit | grep -q . && die "cloudflared file mode drift"
      find "$ETC/cloudflared" \( ! -user root -o ! -group "$TUNNEL_USER" \) -print -quit | grep -q . && die "cloudflared ownership drift"
      [ ! -e "$TUNNEL_SOURCE" ] || die "cloudflared source directory remains in owner home"
      systemctl is-active --quiet "$unit" || die "$unit is not active"
      ;;
    llama-swap)
      require_mode "$ETC/llama-swap" 750
      require_owner_group "$ETC/llama-swap" root "$LLAMA_USER"
      if [ ! -f "$ETC/llama-swap/config.yaml" ]; then
        die "llama-swap config was not moved"
      fi
      require_mode "$ETC/llama-swap/config.yaml" 640
      require_owner_group "$ETC/llama-swap/config.yaml" root "$LLAMA_USER"
      require_mode "$ROOT/llama-swap" 750
      require_owner_group "$ROOT/llama-swap" "$LLAMA_USER" "$LLAMA_USER"
      [ "$(show_value "$unit" PrivateDevices)" = no ] || die "llama-swap PrivateDevices must remain disabled for reviewed GPU access"
      [ "$(show_value "$unit" DevicePolicy)" = closed ] || die "llama-swap DevicePolicy is not closed"
      require_show_exact_device_allow "$unit" "/dev/null:rw" "/dev/urandom:r" "/dev/random:r" "$LLAMA_GPU_RENDER_DEVICE:rw" "$LLAMA_GPU_CARD_DEVICE:rw"
      # systemd canonicalizes `IPAddressDeny=any` to these universal CIDRs in
      # `systemctl show`; validate the effective representation, not source text.
      require_show_exact_set "$unit" IPAddressDeny 0.0.0.0/0 ::/0
      require_show_exact_set "$unit" IPAddressAllow 127.0.0.0/8 ::1/128
      require_show_exact_set "$unit" BindReadOnlyPaths "$LLAMA_TREE" "$LLAMA_MODELS" "$LLAMA_RUNTIME"
      require_show_exact_set "$unit" ReadWritePaths "$ROOT/llama-swap"
      require_show_empty "$unit" BindPaths
      [ ! -e "$LLAMA_TREE/config.yaml" ] || die "legacy llama-swap config remains in owner home"
      systemctl is-active --quiet "$unit" || die "$unit is not active"
      ss -ltn '( sport = :8091 )' | grep -Fq '127.0.0.1:8091' || die "llama-swap is not loopback-bound on :8091"
      ;;
  esac
  note "PASS: $service migration verification completed"
}

apply() {
  local service="$1" backup_root="$2" unit stamp backup
  root_only; need useradd; need install; need systemctl; need curl; need ss; need grep; need sed; need sudo; need runuser; need mktemp; need mv; need chown; need chmod; need find
  if [ "$service" = gateway ]; then need awk; need loginctl; need npm; fi
  unit="$(unit_for "$service")"
  if [ "$(show_value "$unit" User)" = "$(user_for "$service")" ]; then
    verify "$service"
    note "NO-OP: $service is already isolated and verified"
    return 0
  fi
  preflight "$service"
  create_service_user "$(user_for "$service")" "$service"
  if [ "$service" = gateway ]; then
    prepare_gateway_user_manager
    provision_gateway_codeloop_runtime
  fi
  unit="$(unit_for "$service")"; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ "$service" = gateway ]; then
    # A failed cross-filesystem `mv` can leave a partial copy. Require an atomic
    # rename before disabling the owner timer and beginning the transaction.
    install -d -m 0750 -o root -g "$(user_for "$service")" "$ROOT/gateway"
    require_atomic_move "$GATEWAY_DATA" "$ROOT/gateway"
  elif [ "$service" = cloudflared ]; then
    install -d -m 0755 -o root -g root "$ETC"
    require_atomic_move "$TUNNEL_SOURCE" "$ETC"
  else
    install -d -m 0750 -o root -g "$(user_for "$service")" "$ETC/llama-swap"
    require_atomic_move "$LLAMA_TREE/config.yaml" "$ETC/llama-swap"
  fi
  umask 077
  mkdir -p "$backup_root"
  backup="$(mktemp -d "$backup_root/$stamp-$service.XXXXXX")"
  backup_unit "$service" "$unit" "$backup"
  if [ "$service" = gateway ]; then
    APPLY_BACKUP="$backup"
    GATEWAY_APPLY_INFLIGHT=1
    trap 'apply_exit_handler "$?"' EXIT
    disable_legacy_autonomy_timer
  fi
  case "$service" in
    gateway) migrate_gateway_state ;;
    cloudflared) migrate_tunnel_state ;;
    llama-swap) migrate_llama_state ;;
  esac
  # All reversible source/target conflicts must be ruled out before a new
  # drop-in can restart the service. This is also the transaction gate used by
  # the automatic gateway error handler.
  rollback_feasible "$service"
  install_dropin "$service"
  if ! systemctl restart "$unit"; then
    note "Restart failed; use rollback with --ack-rollback. Backup evidence: $backup"
    exit 1
  fi
  [ "$service" != gateway ] || install_gateway_autonomy_timer
  if ! verify "$service" 0; then
    note "Verification failed; use rollback with --ack-rollback. Backup evidence: $backup"
    exit 1
  fi
  printf 'service=%s\nunit=%s\nbackup=%s\nverified_at=%s\n' "$service" "$unit" "$backup" "$(date -u +%FT%TZ)" >"$backup/receipt"
  if [ "$service" = gateway ]; then
    # Future deploys use this durable root-owned identity marker, never timer
    # health, to decide whether they are allowed to touch legacy owner units.
    install -m 0600 -o root -g root /dev/stdin "$GATEWAY_ISOLATION_MARKER" <"$backup/receipt"
  fi
  GATEWAY_APPLY_INFLIGHT=0
  trap - EXIT
  note "APPLIED: $service. Backup/rollback evidence: $backup"
}

rollback() {
  local service="$1" backup_root="$2" unit backup dropin
  root_only; need systemctl; need install; need mv; need chown; need chmod; need find; need sed; need grep; need runuser
  unit="$(unit_for "$service")"
  if [ -f "$backup_root/unit.before.txt" ]; then
    backup="$backup_root"
  else
    backup="$(find "$backup_root" -maxdepth 1 -type d -name "*-$service.*" -print 2>/dev/null | sort | tail -n 1)"
  fi
  [ -n "$backup" ] || die "no recorded backup found for $service"
  [ -f "$backup/unit.before.txt" ] || die "backup is incomplete: $backup"
  if [ -f "$backup/rollback-receipt" ]; then
    [ "$(show_value "$unit" User)" = magnus ] || die "rollback receipt exists but legacy unit identity is not restored"
    systemctl is-active --quiet "$unit" || die "rollback receipt exists but legacy unit is not active"
    case "$service" in
      gateway)
        [ -d "$GATEWAY_DATA" ] && [ -f "$GATEWAY_TREE/.env" ] || die "rollback receipt exists but gateway legacy paths are absent"
        [ ! -e "$GATEWAY_ISOLATION_MARKER" ] && [ ! -e /etc/systemd/system/gille-autonomy-tick.service ] && [ ! -e /etc/systemd/system/gille-autonomy-tick.timer ] || die "rollback receipt exists but isolation artifacts remain"
        assert_legacy_autonomy_timer_state "$backup"
        ;;
      cloudflared) [ -d "$TUNNEL_SOURCE" ] || die "rollback receipt exists but cloudflared legacy path is absent" ;;
      llama-swap) [ -f "$LLAMA_TREE/config.yaml" ] || die "rollback receipt exists but llama legacy config is absent" ;;
    esac
    note "NO-OP: $service is already rolled back and verified"
    return 0
  fi
  rollback_feasible "$service"
  dropin="/etc/systemd/system/$unit.d/50-service-isolation.conf"
  if [ "$service" = gateway ]; then
    if [ -e /etc/systemd/system/gille-autonomy-tick.timer ]; then
      systemctl disable --now gille-autonomy-tick.timer || die "could not stop isolated autonomy timer"
      ! systemctl is-active --quiet gille-autonomy-tick.timer || die "isolated autonomy timer stayed active"
      ! systemctl is-enabled --quiet gille-autonomy-tick.timer || die "isolated autonomy timer stayed enabled"
    fi
  fi
  systemctl stop "$unit" || die "could not stop $unit; refusing rollback mutation"
  ! systemctl is-active --quiet "$unit" || die "$unit stayed active; refusing rollback mutation"
  case "$service" in
    gateway)
      [ ! -d "$GATEWAY_DATA" ] || rmdir "$GATEWAY_DATA"
      mv "$ROOT/gateway/data" "$GATEWAY_DATA"
      chown -R magnus:magnus "$GATEWAY_DATA"
      local legacy_data_mode
      legacy_data_mode="$(cat "$backup/gateway-data.mode")"
      [[ "$legacy_data_mode" =~ ^[0-7]{3,4}$ ]] || die "backup has invalid gateway data mode"
      chmod "$legacy_data_mode" "$GATEWAY_DATA"
      install -m 0600 -o magnus -g magnus "$ETC/gateway/gateway.env" "$GATEWAY_TREE/.env"
      rm -f "$ETC/gateway/gateway.env"
      rm -f /etc/systemd/system/gille-autonomy-tick.service /etc/systemd/system/gille-autonomy-tick.timer
      rm -f "$GATEWAY_ISOLATION_MARKER"
      ;;
    cloudflared)
      # Restore the exact source-root spelling used by the legacy unit/config before restart.
      sed -i "s|$ETC/cloudflared|$TUNNEL_SOURCE|g" "$ETC/cloudflared/config.yml"
      mv "$ETC/cloudflared" "$TUNNEL_SOURCE"
      chown -R magnus:magnus "$TUNNEL_SOURCE"
      chmod 0700 "$TUNNEL_SOURCE"
      find "$TUNNEL_SOURCE" -type f -exec chmod 0600 {} +
      ;;
    llama-swap)
      mv "$ETC/llama-swap/config.yaml" "$LLAMA_TREE/config.yaml"
      chown magnus:magnus "$LLAMA_TREE/config.yaml"
      chmod 0644 "$LLAMA_TREE/config.yaml"
      ;;
  esac
  rm -f "$dropin"
  rmdir "/etc/systemd/system/$unit.d" 2>/dev/null || true
  systemctl daemon-reload
  systemctl restart "$unit"
  if [ "$service" = gateway ]; then
    restore_legacy_autonomy_timer "$backup"
  fi
  [ "$(show_value "$unit" User)" = magnus ] || die "rollback did not restore the legacy magnus unit identity"
  systemctl is-active --quiet "$unit" || die "legacy unit did not recover after rollback"
  printf 'service=%s\nbackup=%s\nrolled_back_at=%s\n' "$service" "$backup" "$(date -u +%FT%TZ)" >"$backup/rollback-receipt"
  note "ROLLED BACK: $service. The unused dedicated account/runtime is retained mode-restricted for forensic recovery; remove it only through a separate owner-approved cleanup."
}

main() {
  [ "$#" -ge 1 ] || { usage; exit 2; }
  local command="$1"; shift
  local service="" output_dir="." backup_dir="$ROOT/isolation-backups" ack_restart=0 ack_rollback=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --service) [ "$#" -ge 2 ] || die "--service needs a value"; service="$2"; shift 2 ;;
      --output-dir) [ "$#" -ge 2 ] || die "--output-dir needs a value"; output_dir="$2"; shift 2 ;;
      --backup-dir) [ "$#" -ge 2 ] || die "--backup-dir needs a value"; backup_dir="$2"; shift 2 ;;
      --ack-service-restart) ack_restart=1; shift ;;
      --ack-rollback) ack_rollback=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$service" ] || die "exactly one service is required"
  unit_for "$service" >/dev/null
  case "$command" in
    render) render "$output_dir" "$service" ;;
    preflight) preflight "$service" ;;
    apply) [ "$ack_restart" = 1 ] || die "apply requires --ack-service-restart"; apply "$service" "$backup_dir" ;;
    verify) verify "$service" ;;
    rollback) [ "$ack_rollback" = 1 ] || die "rollback requires --ack-rollback"; rollback "$service" "$backup_dir" ;;
    refresh-autonomy) [ "$service" = gateway ] || die "refresh-autonomy only applies to gateway"; root_only; install_gateway_autonomy_timer ;;
    *) usage >&2; die "unknown command: $command" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
