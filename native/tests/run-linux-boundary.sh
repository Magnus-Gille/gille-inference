#!/usr/bin/env bash
# Root-only in a disposable GitHub-hosted VM. Never run this on M5 or a workstation.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID == 0 ]] || {
  echo 'refusing: disposable GitHub-hosted root fixture required' >&2; exit 2;
}
[[ $# == 2 && -f $1 && ! -L $1 && -f $2 && ! -L $2 ]] || exit 2
fixture=/run/gi-observer-fixture
policy=/etc/apparmor.d/gi-observer-fixture
polkit=/etc/polkit-1/rules.d/00-gi-observer-fixture.rules
observer=gi-observer-ci
sentinel=gi-sentinel-ci
units=(gi-observer-fixture-waiting.service gi-observer-fixture-blocker.service gi-observer-fixture-target.service gi-observer-fixture-probe.service gi-observer-fixture-control.service gi-observer-fixture-canary.service gi-observer-fixture-sockets.service)
for path in "$fixture" "$policy" "$polkit"; do
  [[ ! -e $path && ! -L $path ]] || { echo 'refusing: fixture path already exists' >&2; exit 2; }
done
for account in "$observer" "$sentinel"; do
  if getent passwd "$account" >/dev/null || getent group "$account" >/dev/null; then
    echo 'refusing: fixture identity already exists' >&2; exit 2
  fi
done
for unit in "${units[@]}"; do
  [[ $(systemctl show "$unit" -p LoadState --value) == not-found ]] || exit 2
done
while IFS= read -r profile; do
  [[ $profile != gi-observer-fixture\ * ]] || { echo 'refusing: profile already loaded' >&2; exit 2; }
done < /sys/kernel/security/apparmor/profiles
root=$(cd "$(dirname "$0")/../.." && pwd -P)
created_users=() created_units=() profile_loaded=0 created_profile=0 created_polkit=0 created_dir=0
cleanup() {
  local original=$? cleanup_failed=0 unit account group path populated
  trap - EXIT
  for unit in "${created_units[@]}"; do
    group=$(systemctl show "$unit" -p ControlGroup --value)
    [[ -z $group || $group == "/system.slice/$unit" ]] || { cleanup_failed=1; continue; }
    systemctl stop "$unit" >/dev/null 2>&1 || cleanup_failed=1
    if [[ $(systemctl show "$unit" -p MainPID --value) != 0 ]]; then cleanup_failed=1; fi
    if [[ $(systemctl show "$unit" -p ControlPID --value) != 0 ]]; then cleanup_failed=1; fi
    if [[ -n $(systemctl show "$unit" -p Job --value) ]]; then cleanup_failed=1; fi
    if [[ -n $group && -e /sys/fs/cgroup$group/cgroup.events ]]; then
      populated=$(awk '$1 == "populated" {print $2}' "/sys/fs/cgroup$group/cgroup.events")
      [[ $populated == 0 ]] || cleanup_failed=1
    fi
  done
  # Refuse removal while fixture processes may remain. The VM is discarded even on failure.
  if (( cleanup_failed == 0 )); then
    for unit in "${created_units[@]}"; do rm -- "/etc/systemd/system/$unit" || cleanup_failed=1; done
    systemctl daemon-reload || cleanup_failed=1
    if (( profile_loaded )); then apparmor_parser -R "$policy" || cleanup_failed=1; fi
    if (( created_profile )); then rm -- "$policy" || cleanup_failed=1; fi
    if (( created_polkit )); then rm -- "$polkit" || cleanup_failed=1; fi
    if (( created_dir )); then
      # Remove only fixture-owned names after the units are proven empty. No recursion.
      for path in probe socket-listener target.pid forbidden peers/forbidden.sock peers/socket.ready; do rm -f -- "$fixture/$path" || cleanup_failed=1; done
      if [[ -d $fixture/peers ]]; then rmdir -- "$fixture/peers" || cleanup_failed=1; fi
      rmdir -- "$fixture" || cleanup_failed=1
    fi
    for account in "${created_users[@]}"; do
      if getent passwd "$account" >/dev/null; then userdel "$account" || cleanup_failed=1; fi
      if getent group "$account" >/dev/null; then groupdel "$account" || cleanup_failed=1; fi
    done
  fi
  (( cleanup_failed == 0 )) || { echo 'fixture cleanup failed' >&2; exit 1; }
  exit "$original"
}
trap cleanup EXIT
mkdir -m 0755 "$fixture"; created_dir=1
install -m 0755 "$1" "$fixture/probe"
install -m 0755 "$2" "$fixture/socket-listener"
printf 'synthetic, non-secret fixture\n' > "$fixture/forbidden"
chmod 0644 "$fixture/forbidden"
for account in "$observer" "$sentinel"; do
  created_users+=("$account")
  useradd --system --no-create-home --user-group --shell /usr/sbin/nologin "$account"
done
install -d -o "$sentinel" -g "$sentinel" -m 0755 "$fixture/peers"
created_profile=1
install -m 0644 "$root/native/tests/observer-fixture.apparmor" "$policy"
apparmor_parser -r "$policy"; profile_loaded=1
created_polkit=1
cat > "$polkit" <<'RULE'
polkit.addRule(function(action, subject) {
  if (subject.user === "gi-observer-ci" && action.id.indexOf("org.freedesktop.systemd1.") === 0) {
    return polkit.Result.NO;
  }
});
RULE
chmod 0644 "$polkit"

write_unit() {
  local unit=$1
  # All callers below use source-constant, checked-absent names.
  created_units+=("$unit")
  cat > "/etc/systemd/system/$unit"
}
# Created first so cleanup cancels the waiting job before stopping its dependency.
write_unit gi-observer-fixture-waiting.service <<'UNIT'
[Unit]
Requires=gi-observer-fixture-blocker.service
After=gi-observer-fixture-blocker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/true
User=gi-sentinel-ci
Group=gi-sentinel-ci
NoNewPrivileges=yes
MemoryMax=32M
TasksMax=1
TimeoutStartSec=10
TimeoutStopSec=2
UNIT
write_unit gi-observer-fixture-blocker.service <<'UNIT'
[Service]
Type=oneshot
ExecStart=/usr/bin/sleep 35
User=gi-sentinel-ci
Group=gi-sentinel-ci
NoNewPrivileges=yes
MemoryMax=32M
TasksMax=1
TimeoutStartSec=40
TimeoutStopSec=2
UNIT
write_unit gi-observer-fixture-target.service <<'UNIT'
[Service]
ExecStart=/usr/bin/sleep infinity
User=gi-sentinel-ci
Group=gi-sentinel-ci
NoNewPrivileges=yes
TimeoutStopSec=2
RuntimeMaxSec=60
UNIT
write_unit gi-observer-fixture-sockets.service <<'UNIT'
[Service]
ExecStart=/run/gi-observer-fixture/socket-listener
User=gi-sentinel-ci
Group=gi-sentinel-ci
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/run/gi-observer-fixture/peers
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX
MemoryMax=32M
TasksMax=1
TimeoutStopSec=2
RuntimeMaxSec=25
UNIT
write_unit gi-observer-fixture-canary.service <<'UNIT'
[Service]
Type=oneshot
ExecStart=/usr/bin/true
User=gi-sentinel-ci
Group=gi-sentinel-ci
NoNewPrivileges=yes
UNIT
for mode in control probe; do
  profile_line= argument=
  if [[ $mode == probe ]]; then profile_line=AppArmorProfile=gi-observer-fixture; else argument=--control; fi
  write_unit "gi-observer-fixture-$mode.service" <<UNIT
[Service]
Type=oneshot
ExecStart=$fixture/probe $argument
User=$observer
Group=$observer
$profile_line
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_SYS_PTRACE
AmbientCapabilities=CAP_SYS_PTRACE
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
ProcSubset=all
PrivateUsers=no
PrivateNetwork=no
PrivateTmp=yes
PrivateDevices=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX
MemoryMax=128M
MemorySwapMax=0
CPUQuota=25%
TasksMax=4
TimeoutStartSec=10
TimeoutStopSec=2
KillMode=control-group
StandardOutput=journal
StandardError=null
UNIT
done
systemctl daemon-reload
systemctl start gi-observer-fixture-sockets.service
for ((attempt=0; attempt<100; attempt++)); do
  [[ ! -f $fixture/peers/socket.ready ]] || break
  sleep 0.02
done
[[ -f $fixture/peers/socket.ready ]] || { echo 'socket fixture readiness failed' >&2; exit 1; }
systemctl start gi-observer-fixture-target.service
systemctl show gi-observer-fixture-target.service -p MainPID --value > "$fixture/target.pid"
chmod 0644 "$fixture/target.pid"
systemctl --no-block start gi-observer-fixture-waiting.service
for ((attempt=0; attempt<100; attempt++)); do
  if [[ $(systemctl show gi-observer-fixture-blocker.service -p ActiveState --value) == activating &&
        -n $(systemctl show gi-observer-fixture-waiting.service -p Job --value) ]]; then break; fi
  sleep 0.02
done
[[ $(systemctl show gi-observer-fixture-blocker.service -p ActiveState --value) == activating &&
   -n $(systemctl show gi-observer-fixture-waiting.service -p Job --value) ]] || {
  echo 'pending job fixture readiness failed' >&2; exit 1;
}
for mode in control probe; do
  unit="gi-observer-fixture-$mode.service"
  result=0
  systemctl start "$unit" >/dev/null 2>&1 || result=$?
  journalctl --quiet -u "$unit" --output=cat --no-pager |
    sed -n -E '/^[a-z-]+: (pass|FAIL)$/p; /^qualifiesObserver: false$/p'
  [[ $result == 0 && $(systemctl show "$unit" -p Result --value) == success ]] || {
    echo "$mode boundary fixture failed" >&2; exit 1;
  }
done
[[ $(systemctl show gi-observer-fixture-canary.service -p InvocationID --value) == '' ]] || {
  echo 'forbidden fixture unit was started' >&2; exit 1;
}
echo 'Linux boundary fixture passed; observer qualification remains incomplete.'
