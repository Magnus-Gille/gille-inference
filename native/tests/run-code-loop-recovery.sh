#!/usr/bin/env bash
# Root-only disposable GitHub-hosted worker fixture; never an M5 installer.
set -Eeuo pipefail
ROOT=/run/gi-code-loop-recovery-fixture
USER_NAME=gi-code-loop-ci
TEST_UID=62056
SLICE=girecovery.slice
GATEWAY=gi-recovery-gateway.service
CANARY=gi-recovery-canary.service
MANAGER=user@62056.service
RUNTIME=user-runtime-dir@62056.service
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$(cd -- "$SCRIPT_DIR/../.." && pwd)
NODE=$(command -v node)
die() { echo "native-recovery: $*" >&2; exit 1; }
require_host() {
  [[ "$EUID" = 0 ]] || die "only root on a disposable GitHub-hosted worker is authorized"
  [[ "$GITHUB_ACTIONS" = true && "$RUNNER_ENVIRONMENT" = github-hosted ]] || die "only disposable GitHub-hosted workers are authorized"
  [[ "$(cat /proc/1/comm)" = systemd ]] || die "systemd PID1 required"
  [[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ]] || die "cgroup v2 required"
}
require_host
OUTPUT=$1
[[ "$OUTPUT" = "$RUNNER_TEMP"/code-loop-recovery-evidence ]] || die "unexpected evidence path"
mkdir -p -- "$OUTPUT"
[[ ! -e "$ROOT" ]] || die "fixture tree already exists"
! getent passwd "$USER_NAME" >/dev/null || die "fixture account already exists"
! getent passwd "$TEST_UID" >/dev/null || die "fixture UID already exists"
! getent group "$USER_NAME" >/dev/null || die "fixture group already exists"
for item in "$SLICE" "$GATEWAY" "$CANARY" "$MANAGER" "$RUNTIME"; do
  [[ "$(systemctl show "$item" -p LoadState --value)" = not-found || "$item" = "$MANAGER" || "$item" = "$RUNTIME" ]] || die "named fixture unit already exists: $item"
done
[[ "$(systemctl show "$MANAGER" -p ActiveState --value)" = inactive ]] || die "fixture manager active"
[[ "$(systemctl show "$RUNTIME" -p ActiveState --value)" = inactive ]] || die "fixture runtime active"
[[ ! -e /run/user/62056 && ! -e /var/lib/systemd/linger/"$USER_NAME" ]] || die "fixture runtime identity exists"
[[ ! -e /etc/systemd/system/"$MANAGER".d && ! -e /etc/systemd/system/"$RUNTIME".d ]] || die "fixture drop-ins already exist"
for cmd in node systemd-run pasta bwrap git python3; do command -v "$cmd" >/dev/null || die "missing native prerequisite: $cmd"; done
CREATED_ACCOUNT=0
CREATED_TREE=0
CREATED_UNITS=0
CREATED_LINGER=0
cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT TERM INT
  set +e
  if ((CREATED_UNITS)); then
    systemctl stop "$GATEWAY" "$MANAGER" "$CANARY" "$RUNTIME" "$SLICE" >/dev/null 2>&1 || cleanup_failed=1
    for unit in "$GATEWAY" "$MANAGER" "$CANARY" "$RUNTIME"; do
      [[ "$(systemctl show "$unit" -p MainPID --value)" = 0 && "$(systemctl show "$unit" -p ControlPID --value)" = 0 ]] || cleanup_failed=1
    done
    if [[ -e /sys/fs/cgroup/girecovery.slice/cgroup.events ]]; then
      grep -qx 'populated 0' /sys/fs/cgroup/girecovery.slice/cgroup.events || cleanup_failed=1
    fi
  fi
  if ((CREATED_TREE)); then
    [[ ! -f "$ROOT/acceptance.json" ]] || cp -- "$ROOT/acceptance.json" "$OUTPUT/acceptance.json"
    [[ ! -f "$ROOT/home/backend-count.json" ]] || cp -- "$ROOT/home/backend-count.json" "$OUTPUT/backend-count.json"
    journalctl --no-pager -u "$GATEWAY" -n 100 > "$OUTPUT/gateway.log" 2>&1
    journalctl --no-pager -u "$MANAGER" -n 80 > "$OUTPUT/manager.log" 2>&1
  fi
  if ((CREATED_LINGER)); then loginctl disable-linger "$USER_NAME" || cleanup_failed=1; fi
  if ((CREATED_UNITS)) && ((cleanup_failed==0)); then
    rm -f -- /etc/systemd/system/"$SLICE" /etc/systemd/system/"$GATEWAY" /etc/systemd/system/"$CANARY"
    rm -rf -- /etc/systemd/system/"$MANAGER".d /etc/systemd/system/"$RUNTIME".d
    systemctl daemon-reload || cleanup_failed=1
  fi
  if ((CREATED_ACCOUNT)) && ((cleanup_failed==0)); then
    userdel "$USER_NAME" || cleanup_failed=1
    if getent group "$USER_NAME" >/dev/null; then groupdel "$USER_NAME" || cleanup_failed=1; fi
  fi
  if ((CREATED_TREE)) && ((cleanup_failed==0)); then rm -rf -- "$ROOT"; fi
  printf '{"cleanup_complete":%s}\n' "$([[ "$cleanup_failed" = 0 ]] && echo true || echo false)" > "$OUTPUT/cleanup.json"
  ((cleanup_failed==0)) || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
mkdir -p "$ROOT"/{source,bin,home,gate}
CREATED_TREE=1
chmod 755 "$ROOT" "$ROOT/bin" "$ROOT/source"
git -C "$SOURCE" archive HEAD | tar -x -C "$ROOT/source"
cp -a "$SOURCE/node_modules" "$ROOT/source/node_modules"
useradd --system --uid "$TEST_UID" --user-group --no-create-home --home-dir "$ROOT/home" --shell /usr/sbin/nologin "$USER_NAME"
CREATED_ACCOUNT=1
chown "$USER_NAME:$USER_NAME" "$ROOT/home" "$ROOT/gate"
chmod 700 "$ROOT/home" "$ROOT/gate"
mkdir "$ROOT/home/pi"
printf '{}\n' > "$ROOT/home/pi/models.json"
printf 'synthetic fixture marker, never a production secret\n' > "$ROOT/home/synthetic-secret-marker.txt"
touch "$ROOT/gate/release"
chown -R "$USER_NAME:$USER_NAME" "$ROOT/home" "$ROOT/gate"
cat > "$ROOT/bin/synthetic-pi" <<'PI'
#!/bin/sh
set -eu
printf 'synthetic cage recovery passed\n' > "$HOME/result.txt"
printf '%s\n' \
  '{"type":"turn_start"}' \
  '{"type":"tool_execution_start","toolCallId":"fixture-write","toolName":"write","args":{"path":"result.txt","content":"synthetic cage recovery passed\n"}}' \
  '{"type":"tool_execution_end","toolCallId":"fixture-write","toolName":"write","isError":false,"result":{"content":[{"type":"text","text":"synthetic write completed"}]}}' \
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Synthetic cage recovery completed."}]}}' \
  '{"type":"turn_end","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0},"stopReason":"stop"}}'
PI
cat > "$ROOT/bin/restart-gate" <<'GATE'
#!/usr/bin/python3
import pathlib,time
root=pathlib.Path("/run/gi-code-loop-recovery-fixture/gate")
if not (root/"release").exists():
    (root/"entered").write_text("automatic restart awaiting test release\n")
    deadline=time.monotonic()+30
    while not (root/"release").exists():
        if time.monotonic()>=deadline: raise SystemExit("bounded fixture restart gate expired")
        time.sleep(0.05)
GATE
chmod 755 "$ROOT/bin/"*
CREATED_UNITS=1
cat > /etc/systemd/system/"$SLICE" <<'SLICE'
[Slice]
MemoryMax=2G
MemorySwapMax=0
CPUQuota=200%
TasksMax=128
SLICE
mkdir /etc/systemd/system/"$MANAGER".d /etc/systemd/system/"$RUNTIME".d
( source "$ROOT/source/scripts/service-isolation.sh"; render_gateway_manager_recovery ) > /etc/systemd/system/"$MANAGER".d/50-recovery.conf
cat > /etc/systemd/system/"$MANAGER".d/60-fixture.conf <<EOF
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=2
[Service]
Slice=$SLICE
ExecStartPre=$ROOT/bin/restart-gate
EOF
printf '[Service]\nSlice=%s\n' "$SLICE" > /etc/systemd/system/"$RUNTIME".d/60-fixture.conf
cat > /etc/systemd/system/"$GATEWAY" <<EOF
[Unit]
Wants=$MANAGER
After=$MANAGER
[Service]
User=$USER_NAME
Group=$USER_NAME
Slice=$SLICE
WorkingDirectory=$ROOT/home
ExecStart=/usr/bin/env -i PATH=$(dirname "$NODE"):/usr/sbin:/usr/bin:/sbin:/bin HOME=$ROOT/home RECOVERY_FIXTURE_ROOT=$ROOT $NODE --import $ROOT/source/node_modules/tsx/dist/loader.mjs $ROOT/source/tests/fixtures/code-loop-recovery-gateway.ts
RuntimeMaxSec=300
TimeoutStopSec=10
KillMode=control-group
ReadWritePaths=$ROOT/home
BindReadOnlyPaths=/run/user/$TEST_UID
PrivateDevices=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
EOF
( source "$ROOT/source/scripts/service-isolation.sh"; render_common ) >> /etc/systemd/system/"$GATEWAY"
cat > /etc/systemd/system/"$CANARY" <<EOF
[Service]
Slice=$SLICE
ExecStart=/usr/bin/sleep 300
RuntimeMaxSec=300
NoNewPrivileges=true
EOF
CREATED_UNITS=1
systemctl daemon-reload
loginctl enable-linger "$USER_NAME"
CREATED_LINGER=1
systemctl start "$SLICE" "$MANAGER" "$CANARY" "$GATEWAY"
systemd-run --quiet --wait --pipe --collect --unit=gi-recovery-driver.service --slice="$SLICE" \
  -p RuntimeMaxSec=180 -p TimeoutStopSec=10 -p KillMode=control-group \
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  "$NODE" "$ROOT/source/tests/fixtures/code-loop-recovery-driver.mjs" "$TEST_UID"
systemctl stop "$GATEWAY"
"$NODE" -e 'const fs=require("fs");const p="/run/gi-code-loop-recovery-fixture/home/backend-count.json";if(JSON.parse(fs.readFileSync(p)).inferenceRequests!==0)throw Error("fixture attempted inference");'
