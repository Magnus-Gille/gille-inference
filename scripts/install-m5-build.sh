#!/usr/bin/env bash
# Owner-attended dedicated build-account provisioning. This is NOT a gateway
# deploy and NEVER installs software, pulls images, formats disks or copies keys.
# Run only from the immutable, root-owned archive staged by deploy-m5-build.sh.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
usage() {
  printf '%s\n' 'install-m5-build.sh preflight|apply <full-release-sha> <image@sha256:digest>' \
    'Prerequisites: root-owned immutable payload; dedicated gille-build account;' \
    'home=/var/lib/gille-build on a separate <=64GiB filesystem; subuid/subgid;' \
    'rootless Podman + systemd cgroup v2; preloaded digest-pinned image;' \
    'approved dedicated SSH public-key provisioning. No keys are read or changed.'
}
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
[[ ${1:-} != --help && ${1:-} != -h ]] || { usage; exit 0; }
[[ $# == 3 ]] || { usage >&2; exit 2; }
mode=$1 release=$2 image=$3
[[ $mode == preflight || $mode == apply ]] || fail 'Use preflight or apply.'
[[ $release =~ ^[0-9a-f]{40}$ ]] || fail 'An accepted full release SHA is required.'
[[ $image =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$ ]] || fail 'A builder image digest is required.'
[[ $EUID == 0 ]] || fail 'Host provisioning needs exact owner approval and root.'
payload=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ $(stat -c %u "$payload") == 0 && $(stat -c %a "$payload") == 700 ]] || fail 'Payload must be an immutable root-owned private archive directory.'
[[ -f $payload/.build-release && ! -L $payload/.build-release ]] || fail 'Missing source identity.'
[[ $(< "$payload/.build-release") == "$release" ]] || fail 'Payload release does not match the approved revision.'
worker=$payload/scripts/m5-build-worker.py
[[ -f $worker && ! -L $worker && $(stat -c %u "$worker") == 0 ]] || fail 'Worker payload must be a root-owned regular file.'
if ! command -v podman >/dev/null || ! command -v loginctl >/dev/null; then
  fail 'Install Podman/systemd separately under approved host maintenance.'
fi
[[ -x /usr/bin/podman && -x /usr/sbin/sshd ]] || fail 'Expected system Podman and OpenSSH paths missing.'
uid=$(id -u gille-build) || fail 'Provision the dedicated build identity first.'
[[ $uid != 0 ]] || fail 'Build identity may not be root.'
home=$(getent passwd gille-build | cut -d: -f6)
[[ $home == /var/lib/gille-build ]] || fail 'Dedicated build account home mismatch.'
[[ $(id -Gn gille-build) == gille-build ]] || fail 'Build identity must not belong to privileged or production groups.'
[[ -d $home && ! -L $home && $(stat -c %u "$home") == "$uid" && $(stat -c %a "$home") == 700 ]] || fail 'Dedicated home permissions unsafe.'
mountpoint -q "$home" || fail 'Provision a separate capacity-bounded build filesystem first; never use the production filesystem.'
python3 - "$home" <<'PY'
import shutil, sys
usage = shutil.disk_usage(sys.argv[1])
if usage.total > 64 * 1024**3 or usage.free < 1024**3:
    raise SystemExit('ERROR: Build filesystem must be <=64GiB with >=1GiB free.')
PY
grep -q '^gille-build:[0-9]\+:[0-9]\+$' /etc/subuid || fail 'Dedicated subordinate UIDs required.'
grep -q '^gille-build:[0-9]\+:[0-9]\+$' /etc/subgid || fail 'Dedicated subordinate GIDs required.'
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]] || fail 'cgroup v2 is required; no unsafe fallback.'
[[ $(loginctl show-user gille-build --property=Linger --value) == yes ]] || fail 'Enable the dedicated user manager separately in the approved account-provisioning ceremony.'
[[ -S /run/user/$uid/bus ]] || fail 'Dedicated user-manager bus unavailable.'
run_build() {
  runuser -u gille-build -- env -i PATH=/usr/bin:/bin HOME="$home" USER=gille-build \
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}
[[ -z $(run_build /usr/bin/podman ps -q) ]] || fail 'Existing build containers must finish before installation.'
run_build /usr/bin/podman image exists "$image" || fail 'Preload the approved builder image digest; no implicit network pull.'
run_build /usr/bin/podman info --format=json | python3 -c '
import json,sys
h=json.load(sys.stdin)["host"]
assert h["security"]["rootless"] is True and h["cgroupVersion"]=="v2" and h["cgroupManager"]=="systemd"
' || fail 'Rootless/systemd/cgroup-v2 runtime contract failed.'
[[ $mode != preflight ]] || { printf 'PASS: dedicated build host preflight; no mutation.\n'; exit 0; }

# Caller must hold the root-owned deployment lock across preflight/apply/verify.
install -d -o root -g root -m 755 /run/gille-build
exec 9>/run/gille-build/install.lock
chmod 644 /run/gille-build/install.lock
flock -n 9 || fail 'A build or another installation is in progress.'
release_dir=/opt/gille-build/releases/$release
[[ ! -e $release_dir ]] || fail 'Release already staged; verify or use a new approved release, do not overwrite it.'
install -d -o root -g root -m 755 /opt/gille-build/releases /usr/local/libexec /etc/gille-build-backups
backup=$(mktemp -d /etc/gille-build-backups/"$release".XXXXXX)
chmod 700 "$backup"
printf 'Rollback record before mutation: %s\n' "$backup"
# Exact prior root-owned configs/links are retained for explicit rollback.
for file in /etc/gille-build.json /usr/local/libexec/m5-build-worker /etc/ssh/sshd_config.d/70-gille-build.conf \
  /etc/systemd/system/gille-build-cleanup.service /etc/systemd/system/gille-build-cleanup.timer; do
  if [[ -e $file || -L $file ]]; then cp -a -- "$file" "$backup/$(basename "$file")"; fi
done
slice_dir=/etc/systemd/system/user-$uid.slice.d
if [[ -f $slice_dir/70-gille-build.conf ]]; then cp -a "$slice_dir/70-gille-build.conf" "$backup/slice.conf"; fi
printf '%s\n' "$release" > "$backup/requested-release"
install -d -o root -g root -m 755 "$release_dir"
install -o root -g root -m 755 "$worker" "$release_dir/m5-build-worker.py"
[[ $(sha256sum "$worker" | cut -d' ' -f1) == $(sha256sum "$release_dir/m5-build-worker.py" | cut -d' ' -f1) ]] || fail 'Worker copy identity mismatch.'
python3 - "$image" > /etc/gille-build.json.new <<'PY'
import json, sys
print(json.dumps(dict(version=1, image=sys.argv[1], podman='/usr/bin/podman')))
PY
chmod 644 /etc/gille-build.json.new
mv -T /etc/gille-build.json.new /etc/gille-build.json
ln -s "$release_dir/m5-build-worker.py" /usr/local/libexec/.m5-build-worker.new
mv -Tf /usr/local/libexec/.m5-build-worker.new /usr/local/libexec/m5-build-worker
install -d -o root -g root -m 755 "$slice_dir" /etc/ssh/sshd_config.d
printf '%s\n' 'd /run/gille-build 0755 root root -' 'f /run/gille-build/install.lock 0644 root root -' > /etc/tmpfiles.d/gille-build.conf
printf '%s\n' '[Slice]' 'CPUQuota=600%' 'CPUWeight=10' 'IOWeight=10' 'MemoryMax=24G' \
  'MemorySwapMax=0' 'TasksMax=1700' > "$slice_dir/70-gille-build.conf"
cat > /etc/ssh/sshd_config.d/70-gille-build.conf <<'SSH'
Match User gille-build
    ForceCommand /usr/local/libexec/m5-build-worker
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    PermitUserRC no
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
Match all
SSH
# Reject hosts that don't include the drop-in, or have an earlier overriding rule.
/usr/sbin/sshd -t || fail 'OpenSSH configuration invalid; restore the recorded backup before reload.'
/usr/sbin/sshd -T -C user=gille-build,host=localhost,addr=127.0.0.1 | python3 -c '
import sys
v=dict(line.strip().split(" ",1) for line in sys.stdin if " " in line)
for k,w in {"forcecommand":"/usr/local/libexec/m5-build-worker", "authenticationmethods":"publickey", "passwordauthentication":"no", "kbdinteractiveauthentication":"no", "permittty":"no", "permituserrc":"no", "allowtcpforwarding":"no", "allowstreamlocalforwarding":"no", "x11forwarding":"no", "permittunnel":"no", "gatewayports":"no"}.items():
    assert v.get(k)==w, "Build SSH policy not effective: "+k
' || fail 'Dedicated SSH restrictions not effective; do not enable access.'
cat > /etc/systemd/system/gille-build-cleanup.service <<UNIT
[Unit]
Description=Remove stale idle M5 build worktrees (not production state)
After=user@$uid.service
Requires=user@$uid.service
[Service]
Type=oneshot
User=gille-build
Group=gille-build
ExecStart=/usr/local/libexec/m5-build-worker --cleanup
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/gille-build/state
Nice=19
IOSchedulingClass=idle
UNIT
cat > /etc/systemd/system/gille-build-cleanup.timer <<'UNIT'
[Unit]
Description=Daily stale M5 build workspace cleanup
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT
install -d -o gille-build -g gille-build -m 700 "$home/state"
systemctl daemon-reload
# Apply aggregate quotas to the already-running dedicated slice immediately.
systemctl set-property "user-$uid.slice" CPUQuota=600% CPUWeight=10 IOWeight=10 MemoryMax=24G MemorySwapMax=0 TasksMax=1700
systemctl enable --now gille-build-cleanup.timer
# Reload ONLY sshd. The gateway, model serving, tunnel and autonomy units are
# never stopped/restarted/installed here. Distribution unit identity is explicit.
if systemctl is-active --quiet ssh.service; then systemctl reload ssh.service
elif systemctl is-active --quiet sshd.service; then systemctl reload sshd.service
else fail 'No known active OpenSSH unit; explicit host-specific review required.'; fi
printf 'PASS: build worker installed; rollback backup: %s\n' "$backup"
printf '%s\n' 'SSH key provisioning and protected inference acceptance remain owner-attended.'
