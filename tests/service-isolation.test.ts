import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const script = join(root, "scripts", "service-isolation.sh");

function render(service: string): string {
  const out = mkdtempSync(join(tmpdir(), "gille-isolation-render-"));
  execFileSync("bash", [script, "render", "--service", service, "--output-dir", out], {
    cwd: root,
    encoding: "utf8",
  });
  return readFileSync(join(out, `${service}.conf`), "utf8");
}

function verifyLlamaDeviceAllow(effective: string): string {
  return execFileSync(
    "bash",
    [
      "-c",
      "source \"$1\"; effective=\"$2\"; show_value() { printf '%s\\n' \"$effective\"; }; require_llama_device_allow llama-swap.service",
      "--",
      script,
      effective,
    ],
    { cwd: root, encoding: "utf8", stderr: "pipe" },
  );
}

function runGatewayApplyFailureHarness(): string {
  const work = mkdtempSync(join(tmpdir(), "gille-isolation-harness-"));
  const log = join(work, "order.log");
  const harness = join(work, "harness.sh");
  writeFileSync(harness, `#!/usr/bin/env bash
LOG="$2"; BACKUP_ROOT="$3"; source "$1"
record() { printf '%s\\n' "$1" >> "$LOG"; }
root_only() { :; }; need() { :; }; show_value() { printf 'magnus\\n'; }
preflight() { :; }; create_service_user() { :; }; prepare_gateway_user_manager() { :; }; provision_gateway_codeloop_runtime() { :; }; install() { :; }; stat() { printf '1\\n'; }
backup_unit() { mkdir -p "$3"; printf 'enabled\\n' > "$3/legacy-timer.enabled"; printf 'active\\n' > "$3/legacy-timer.active"; }
disable_legacy_autonomy_timer() { record disable; }
migrate_gateway_state() { record migrate; false; }
cleanup_gateway_partial_secret() { record cleanup; }
restore_legacy_autonomy_timer() { record restore; }
systemctl() { [ "$1" = is-active ] && return 0; return 0; }
apply gateway "$BACKUP_ROOT"
`, { mode: 0o755 });
  try {
    execFileSync("bash", [harness, script, log, work], { cwd: root, encoding: "utf8" });
  } catch {
    // The intentional migration failure propagates after the EXIT handler restores safety.
  }
  return readFileSync(log, "utf8");
}

function runUserManagerHarness(readyOnAttempt: number | null): { status: number; output: string } {
  const work = mkdtempSync(join(tmpdir(), "gille-user-manager-harness-"));
  const harness = join(work, "harness.sh");
  writeFileSync(harness, `#!/usr/bin/env bash
source "$1"
attempt=0
id() { printf '4242\\n'; }
loginctl() { if [ "$1" = show-user ]; then printf 'yes\\n'; else return 0; fi; }
systemctl() { [ "$1" = start ] && printf 'started:%s\\n' "$2"; }
gateway_user_bus_ready() { attempt=$((attempt + 1)); [ "$attempt" -ge "${readyOnAttempt ?? 999}" ]; }
runuser() { printf 'probe\\n'; }
sleep() { :; }
prepare_gateway_user_manager
`, { mode: 0o755 });
  try {
    return { status: 0, output: execFileSync("bash", [harness, script], { cwd: root, encoding: "utf8", stderr: "pipe" }) };
  } catch (error: any) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function runAutonomyRefreshHarness(failChown = false): { status: number; log: string[]; work: string; output: string } {
  const work = mkdtempSync(join(tmpdir(), "gille-autonomy-refresh-harness-"));
  const harness = join(work, "harness.sh");
  writeFileSync(harness, `#!/usr/bin/env bash
WORK="$2"; FAIL_CHOWN="$3"; LOG="$WORK/order.log"; source "$1"
record() { printf '%s\\n' "$1" >> "$LOG"; }
install() {
  record "install:$*"
  case " $* " in
    *" /dev/stdin "*) record rejected-dev-stdin; return 72 ;;
    *" -d "*) return 0 ;;
  esac
  return 98
}
mktemp() {
  local requested="$1" path
  case "$requested" in
    */.autonomy-notify.sh.XXXXXX) path="$WORK/.autonomy-notify.sh.tmp" ;;
    */.gille-autonomy-tick.service.XXXXXX) path="$WORK/.gille-autonomy-tick.service.tmp" ;;
    */.gille-autonomy-tick.timer.XXXXXX) path="$WORK/.gille-autonomy-tick.timer.tmp" ;;
    *) return 97 ;;
  esac
  : > "$path"
  printf '%s\\n' "$path"
}
sed() { printf '%s\\n' '#!/usr/bin/env bash' 'exec true'; }
chown() {
  record "chown:$*"
  if [ "$FAIL_CHOWN" = 1 ] && [[ "$*" = *"gille-autonomy-tick.timer"* ]]; then return 73; fi
}
chmod() {
  local mode="$1" path="$2"
  record "chmod:$*"
  case "$path" in
    /var/lib/gille-inference/gateway/bin/*|/etc/systemd/system/*) path="$WORK/installed-\${path##*/}" ;;
  esac
  command chmod "$mode" "$path"
}
mv() {
  local source="$1" destination="$2" translated
  record "mv:$destination"
  translated="$WORK/installed-\${destination##*/}"
  command mv "$source" "$translated"
}
rm() { record "rm:$*"; command rm "$@"; }
systemctl() {
  record "systemctl:$*"
  case "$1" in daemon-reload|enable|is-active) return 0 ;; *) return 96 ;; esac
}
install_gateway_autonomy_timer
`, { mode: 0o755 });
  try {
    const output = execFileSync("bash", [harness, script, work, failChown ? "1" : "0"], {
      cwd: root,
      encoding: "utf8",
      stderr: "pipe",
    });
    return { status: 0, log: readFileSync(join(work, "order.log"), "utf8").trim().split("\n").filter(Boolean), work, output };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      log: existsSync(join(work, "order.log"))
        ? readFileSync(join(work, "order.log"), "utf8").trim().split("\n").filter(Boolean)
        : [],
      work,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

function runLlamaTransactionHarness(
  command: "apply" | "rollback" | "failed-apply-rollback" | "failed-apply-invalid-evidence-rollback" | "failed-rollback-retry",
  gatewayInitiallyActive: boolean,
  failure: "none" | "start" | "health" = "none",
): { status: number; log: string[]; output: string } {
  const work = mkdtempSync(join(tmpdir(), "gille-llama-dependent-harness-"));
  const log = join(work, "order.log");
  const backup = join(work, "backup");
  const harness = join(work, "harness.sh");
  execFileSync("mkdir", ["-p", backup]);
  writeFileSync(join(backup, "unit.before.txt"), "legacy unit\n");
  writeFileSync(harness, `#!/usr/bin/env bash
LOG="$2"; BACKUP="$3"; COMMAND="$4"; gateway_active="$5"; FAILURE="$6"; source "$1"
record() { printf '%s\\n' "$1" >> "$LOG"; }
note() { case "$1" in APPLIED:*|ROLLED\\ BACK:*) record success ;; esac; }
root_only() { :; }; need() { :; }; preflight() { :; }; create_service_user() { :; }
require_atomic_move() { :; }; install() { :; }; rollback_feasible() { :; }; install_dropin() { :; }
backup_unit() { mkdir -p "$3"; printf 'legacy unit\\n' > "$3/unit.before.txt"; }
migrate_llama_state() { record migrate; gateway_active=0; }
verify() { record verify; }
mv() { :; }; chown() { :; }; chmod() { :; }; rm() { :; }; rmdir() { :; }
show_value() {
  if [ "$2" = User ]; then printf 'magnus\\n'; return; fi
  if [ "$1" = home-gateway.service ] && [ "$2" = ActiveState ]; then
    if [ "$gateway_active" = 1 ]; then printf 'active\\n'; else printf 'inactive\\n'; fi
    return
  fi
  printf '\\n'
}
systemctl() {
  local action="$1"; shift
  [ "\${1:-}" != --quiet ] || shift
  case "$action:\${1:-}" in
    stop:llama-swap.service) record llama-stop; llama_active=0; gateway_active=0 ;;
    restart:llama-swap.service)
      record llama-restart
      case "\${TRANSACTION:-$COMMAND}" in
        failed-apply) return 1 ;;
        failed-rollback) exit 1 ;;
      esac
      llama_active=1
      ;;
    start:home-gateway.service)
      record gateway-start
      [ "$FAILURE" != start ] || return 1
      gateway_active=1
      ;;
    is-active:home-gateway.service) [ "$gateway_active" = 1 ] ;;
    is-active:llama-swap.service) [ "\${llama_active:-1}" = 1 ] ;;
    daemon-reload:) record daemon-reload ;;
  esac
}
wait_for_gateway_health() {
  record gateway-health
  [ "$FAILURE" != health ]
}
case "$COMMAND" in
  apply) apply llama-swap "$BACKUP" ;;
  rollback) rollback llama-swap "$BACKUP" ;;
  failed-apply-rollback|failed-apply-invalid-evidence-rollback)
    TRANSACTION=failed-apply
    if (apply llama-swap "$BACKUP"); then exit 99; fi
    record apply-failed
    gateway_active=0
    TRANSACTION=rollback
    transaction_backup="$(find "$BACKUP" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    if [ "$COMMAND" = failed-apply-invalid-evidence-rollback ]; then
      printf 'unreviewed.service=active\\n' > "$transaction_backup/dependents.apply.state"
    fi
    rollback llama-swap "$transaction_backup"
    ;;
  failed-rollback-retry)
    printf 'verified\\n' > "$BACKUP/receipt"
    TRANSACTION=failed-rollback
    if (rollback llama-swap "$BACKUP"); then exit 99; fi
    record rollback-failed
    gateway_active=0
    TRANSACTION=rollback
    rollback llama-swap "$BACKUP"
    ;;
esac
`, { mode: 0o755 });
  try {
    const output = execFileSync("bash", [harness, script, log, backup, command, gatewayInitiallyActive ? "1" : "0", failure], {
      cwd: root,
      encoding: "utf8",
      stderr: "pipe",
    });
    return { status: 0, log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean), output };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("service-isolation migration contract (#151)", () => {
  it("waits for delayed gateway health but times out fail-closed without printing its locator", () => {
    const delayed = execFileSync("bash", ["-c", `source "$1"; count=0; systemctl(){ return 0; }; gateway_health_url(){ printf 'private-locator'; }; curl(){ count=$((count+1)); [ "$count" -ge 3 ]; }; sleep(){ :; }; wait_for_gateway_health home-gateway.service; printf '%s' "$count"`, "--", script], { encoding: "utf8" });
    expect(delayed).toBe("3");
    let timeoutOutput = "";
    try {
      execFileSync("bash", ["-c", `source "$1"; systemctl(){ return 0; }; gateway_health_url(){ printf 'private-locator'; }; curl(){ return 1; }; sleep(){ :; }; wait_for_gateway_health home-gateway.service`, "--", script], { encoding: "utf8", stderr: "pipe" });
    } catch (error: any) {
      timeoutOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    expect(timeoutOutput).toContain("bounded 30s readiness window");
    expect(timeoutOutput).not.toContain("private-locator");
    expect(readFileSync(script, "utf8")).toContain("--connect-timeout 1 --max-time 4");
  });

  it("waits for a delayed lingered user manager bus after explicitly starting user@UID", () => {
    const result = runUserManagerHarness(3);
    expect(result.status).toBe(0);
    expect(result.output).toContain("started:user@4242.service");
  });

  it("fails closed with actionable user-manager context when the bus never becomes ready", () => {
    const result = runUserManagerHarness(null);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("did not become ready after 10s");
    expect(result.output).toContain("journalctl -u user@4242.service");
  });

  it("allows only reviewed Pi package provenance when cloning the code-loop runtime", () => {
    const mario = "/home/magnus/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js";
    const earendil = "/home/magnus/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
    expect(execFileSync("bash", ["-c", "source \"$1\"; gateway_codeloop_package_from_resolved_path \"$2\"", "--", script, mario], { encoding: "utf8" }).trim()).toBe("@mariozechner/pi-coding-agent");
    expect(execFileSync("bash", ["-c", "source \"$1\"; gateway_codeloop_package_from_resolved_path \"$2\"", "--", script, earendil], { encoding: "utf8" }).trim()).toBe("@earendil-works/pi-coding-agent");
    expect(() => execFileSync("bash", ["-c", "source \"$1\"; gateway_codeloop_package_from_resolved_path \"$2\"", "--", script, "/tmp/unknown/cli.js"], { encoding: "utf8" })).toThrow();
  });

  it("is executable from the committed tree for the documented direct invocation", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
    expect(execFileSync(script, ["--help"], { cwd: root, encoding: "utf8" })).toContain("Usage: scripts/service-isolation.sh");
  });

  it.each(["gateway", "cloudflared", "llama-swap"])("renders a fail-closed hardened %s drop-in", (service) => {
    const unit = render(service);
    expect(unit).toContain("# Generated by scripts/service-isolation.sh; do not hand-edit.");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ProtectHome=tmpfs");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("RestrictSUIDSGID=true");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).not.toContain("User=magnus");
  });

  it("keeps the gateway's durable state and secret file outside the owner home", () => {
    const unit = render("gateway");
    expect(unit).toContain("User=gille-gateway");
    expect(unit).toContain("EnvironmentFile=/etc/gille-inference/gateway/gateway.env");
    expect(unit).toContain("BindPaths=/var/lib/gille-inference/gateway/data:/home/magnus/home-server-eval/data");
    expect(unit).toContain("BindReadOnlyPaths=/home/magnus/home-server-eval");
    expect(unit).toContain("InaccessiblePaths=-/home/magnus/home-server-eval/.claude");
    expect(unit).toContain("InaccessiblePaths=-/home/magnus/home-server-eval/.ssh");
    expect(unit).not.toContain("BindReadOnlyPaths=/home/magnus\n");
    expect(unit).toContain("Environment=HOMESERVER_CODE_LOOP_WORKROOT=/var/lib/gille-inference/gateway/data/code-loop-work");
    expect(unit).not.toContain("/var/lib/gille-inference/gateway/code-loop-work");
    expect(unit).toContain("Environment=HOMESERVER_CODE_LOOP_PI_BIN=/var/lib/gille-inference/gille-gateway/.local/bin/pi");
    expect(unit).toContain("Environment=HOMESERVER_CODE_LOOP_PI_AGENT_DIR=/var/lib/gille-inference/gille-gateway/.pi-code-loop");
  });

  it("allows cloudflared only the network and files it requires", () => {
    const unit = render("cloudflared");
    expect(unit).toContain("User=gille-cloudflared");
    expect(unit).toContain("ExecStart=/usr/bin/cloudflared --config /etc/gille-inference/cloudflared/config.yml --no-autoupdate tunnel run m5-inference");
    expect(unit).toContain("ReadOnlyPaths=/etc/gille-inference/cloudflared");
    expect(unit).toContain("MemoryDenyWriteExecute=true");
  });

  it("keeps llama-swap loopback-only and explicitly grants the render device group", () => {
    const unit = render("llama-swap");
    expect(unit).toContain("User=gille-llama-swap");
    expect(unit).toContain("SupplementaryGroups=render video");
    expect(unit).toContain("BindReadOnlyPaths=/home/magnus/models");
    expect(unit).toContain("BindReadOnlyPaths=/home/magnus/llama.cpp");
    expect(unit).toContain("DeviceAllow=/dev/dri/renderD128 rw");
    expect(unit).toContain("DeviceAllow=/dev/dri/card0 rw");
    expect(unit).toContain("ProtectClock=true");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("IPAddressAllow=127.0.0.0/8");
    expect(unit).toContain("IPAddressAllow=::1/128");
    expect(unit.indexOf("DeviceAllow=\n")).toBeLessThan(unit.indexOf("DeviceAllow=/dev/null rw"));
  });

  it("accepts the exact llama-swap device set including ProtectClock's implied RTC rule regardless of order", () => {
    const effective = [
      "/dev/dri/card0 rw",
      "char-rtc r",
      "/dev/random r",
      "/dev/null rw",
      "/dev/dri/renderD128 rw",
      "/dev/urandom r",
    ].join(" ");
    expect(verifyLlamaDeviceAllow(effective)).toBe("");
  });

  it("rejects every additional effective llama-swap device rule", () => {
    const effective = [
      "/dev/null rw",
      "/dev/urandom r",
      "/dev/random r",
      "/dev/dri/renderD128 rw",
      "/dev/dri/card0 rw",
      "char-rtc r",
      "/dev/mem r",
    ].join(" ");
    expect(() => verifyLlamaDeviceAllow(effective)).toThrow(/effective DeviceAllow differs from the reviewed allowlist/);
  });

  it("rejects unknown services and does not silently apply all services", () => {
    expect(() => execFileSync("bash", [script, "render", "--service", "all"], { cwd: root, encoding: "utf8" }))
      .toThrow(/unknown service/i);
  });

  it("keeps code-loop auth and owner-home paths out of the migration payload", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("loginctl enable-linger");
    expect(source).toContain("DBUS_SESSION_BUS_ADDRESS");
    expect(source).toContain("dedicated Pi runtime contains auth.json");
    expect(source).toContain("[ ! -e \"$home/.pi-code-loop/auth.json\" ]");
    expect(source).not.toContain("BindReadOnlyPaths=/home/magnus\n");
    expect(source).toContain("InaccessiblePaths=-$GATEWAY_TREE/.claude");
    expect(source).toContain("list-units 'code-loop-*.scope' --state=active --no-legend --plain)\" || die \"could not query Magnus code-loop scopes");
    expect(source).toContain("[ -z \"$active_scopes\" ] || die \"active Magnus code-loop scope exists");
    expect(source).toContain("show gille-autonomy-tick.service -p ActiveState --value)\" || die \"could not query Magnus autonomy tick state");
    expect(source).toContain('case "$autonomy_state" in inactive|failed)');
    expect(source).not.toContain("cp -a \"$source_agent\"");
  });

  it("has a real one-service rollback path and keeps tunnel credentials root-owned", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('chown -R "root:$TUNNEL_USER" "$ETC/cloudflared"');
    expect(source).toContain('find "$ETC/cloudflared" -type d -exec chmod 0750 {} +');
    expect(source).toContain('find "$ETC/cloudflared" -type f -exec chmod 0640 {} +');
    expect(source).toContain('find "$ETC/cloudflared" \\( ! -user root -o ! -group "$TUNNEL_USER" \\) -print -quit');
    expect(source).toContain('rm -f "$dropin"');
    expect(source).toContain('mv "$ROOT/gateway/data" "$GATEWAY_DATA"');
    expect(source).toContain('mv "$ETC/cloudflared" "$TUNNEL_SOURCE"');
    expect(source).toContain('rollback-receipt');
  });

  it("does not duplicate or overwrite state during an apply/rollback lifecycle", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('[ ! -e "/etc/systemd/system/$unit.d/50-service-isolation.conf" ]');
    expect(source).toContain('[ ! -d "$ROOT/gateway/data" ] || rmdir "$ROOT/gateway/data"');
    expect(source).toContain('mv "$LLAMA_TREE/config.yaml" "$ETC/llama-swap/config.yaml"');
    expect(source).toContain('[ ! -e "$LLAMA_TREE/config.yaml" ] || die "legacy llama-swap config remains in owner home"');
    expect(source).toContain('rm -f "$ETC/gateway/gateway.env"');
    expect(source).toContain('mv "$ETC/llama-swap/config.yaml" "$LLAMA_TREE/config.yaml"');
  });

  it("moves the autonomy cadence with gateway state instead of leaving the owner timer behind", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("disable_legacy_autonomy_timer");
    expect(source).toContain("install_gateway_autonomy_timer");
    expect(source).toContain("Environment=GILLE_AUTONOMY_ENV_FILE=$ETC/gateway/gateway.env");
    expect(source).toContain("systemctl is-active --quiet gille-autonomy-tick.timer");
  });

  it("refreshes real rendered autonomy units without passing process-substitution stdin to install", () => {
    const result = runAutonomyRefreshHarness();
    expect(result.status, result.output).toBe(0);
    expect(result.log).not.toContain("rejected-dev-stdin");
    expect(readFileSync(join(result.work, "installed-gille-autonomy-tick.service"), "utf8"))
      .toContain("EnvironmentFile=/etc/gille-inference/gateway/gateway.env");
    expect(readFileSync(join(result.work, "installed-gille-autonomy-tick.timer"), "utf8"))
      .toContain("OnCalendar=*-*-* 05:30:00");
    expect(result.log).toContain("chown:root:root " + join(result.work, ".gille-autonomy-tick.service.tmp"));
    expect(result.log).toContain("chmod:0644 " + join(result.work, ".gille-autonomy-tick.timer.tmp"));
    expect(result.log.indexOf("mv:/etc/systemd/system/gille-autonomy-tick.timer"))
      .toBeLessThan(result.log.indexOf("systemctl:daemon-reload"));
    expect(readdirSync(result.work).filter((name) => name.startsWith(".gille-autonomy-tick"))).toEqual([]);
  });

  it("cleans destination-filesystem unit temporaries and stays fail-closed when refresh preparation fails", () => {
    const result = runAutonomyRefreshHarness(true);
    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("systemctl:daemon-reload");
    expect(readdirSync(result.work).filter((name) => name.startsWith(".gille-autonomy-tick"))).toEqual([]);
  });

  it("uses the configured tailnet listener rather than assuming gateway loopback", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("gateway_health_url()");
    expect(source).toContain('"$(gateway_health_url)"');
    expect(source).not.toContain("http://127.0.0.1:8080/healthz");
  });

  it("makes repeat apply and rollback verified no-ops", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("NO-OP: $service is already isolated and verified");
    expect(source).toContain("NO-OP: $service is already rolled back and verified");
    expect(source).toContain('systemctl stop "$unit" || die "could not stop $unit; refusing rollback mutation"');
    expect(source).toContain("isolated autonomy timer stayed active");
    expect(source).toContain('if ! verify "$service" 0; then');
    expect(source).toContain('rollback_feasible "$service"\n  install_dropin "$service"');
  });

  it("verifies effective systemd capability, filesystem, and loopback/device constraints", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('require_show_empty "$unit" CapabilityBoundingSet');
    expect(source).toContain('require_show_exact_set "$unit" BindPaths "$ROOT/gateway/data:$GATEWAY_DATA"');
    expect(source).toContain('require_show_exact_set "$unit" InaccessiblePaths "-$GATEWAY_TREE/.claude"');
    expect(source).toContain('[ "$(show_value "$unit" DevicePolicy)" = closed ]');
    expect(source).toContain('require_llama_device_allow "$unit"');
    expect(source).toContain('[ "$(show_value "$unit" ProtectClock)" = yes ]');
    expect(source).toContain('require_show_exact_set "$unit" IPAddressDeny 0.0.0.0/0 ::/0');
    expect(source).toContain('require_show_exact_set "$unit" IPAddressAllow 127.0.0.0/8 ::1/128');
  });

  it("normalizes canonical bind modifiers and rejects extra effective allowlist entries", () => {
    const normalized = execFileSync("bash", ["-c", "source \"$1\"; printf '%s\\n' '/a:/a:rbind /b:rw /c' | normalize_show_set", "--", script], { encoding: "utf8" });
    expect(normalized.trim().split("\n")).toEqual(["/a", "/b", "/c"]);
    const source = readFileSync(script, "utf8");
    expect(source).toContain('require_show_exact_set "$unit" BindPaths "$ROOT/gateway/data:$GATEWAY_DATA"');
    expect(source).toContain('require_show_exact_set "$unit" RestrictAddressFamilies AF_UNIX AF_INET AF_INET6');
    expect(source).toContain('require_show_empty "$unit" BindReadOnlyPaths');
    expect(source).toContain('require_show_empty "$unit" BindPaths');
    expect(source).toContain('effective $property differs from the reviewed allowlist');
    expect(source).toContain('effective DeviceAllow differs from the reviewed allowlist');
  });

  it("restores the legacy timer when gateway state migration fails after it was disabled", () => {
    expect(runGatewayApplyFailureHarness().trim().split("\n")).toEqual(["disable", "migrate", "cleanup", "restore"]);
  });

  it("distinguishes sudo's successful no-rule listing from an actual command grant", () => {
    const denied = "User gille-gateway is not allowed to run sudo on m5.";
    const granted = "User gille-gateway may run the following commands on m5:\n    (ALL) NOPASSWD: ALL";
    expect(execFileSync("bash", ["-c", "source \"$1\"; sudo_output_is_nonprivileged \"$2\"", "--", script, denied], { encoding: "utf8" })).toBe("");
    expect(() => execFileSync("bash", ["-c", "source \"$1\"; sudo_output_is_nonprivileged \"$2\"", "--", script, granted], { encoding: "utf8" }))
      .toThrow();
  });

  it("keeps the shared config parent traversable across sequential service migrations", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('install -d -m 0755 -o root -g root "$ETC"');
    expect(source).toContain('install -d -m 0750 -o root -g "$GATEWAY_USER" "$ETC/gateway"');
    expect(source).toContain('install -d -m 0750 -o root -g "$LLAMA_USER" "$ETC/llama-swap"');
  });

  it.each(["apply", "rollback"] as const)("restores and health-checks an active gateway after llama-swap %s", (command) => {
    const result = runLlamaTransactionHarness(command, true);
    expect(result.status, result.output).toBe(0);
    expect(result.log).toContain("gateway-start");
    expect(result.log).toContain("gateway-health");
    expect(result.log.indexOf("gateway-start")).toBeLessThan(result.log.indexOf("gateway-health"));
    expect(result.log.indexOf("gateway-health")).toBeLessThan(result.log.indexOf("success"));
  });

  it.each(["apply", "rollback"] as const)("preserves an intentionally inactive gateway during llama-swap %s", (command) => {
    const result = runLlamaTransactionHarness(command, false);
    expect(result.status, result.output).toBe(0);
    expect(result.log).not.toContain("gateway-start");
    expect(result.log).not.toContain("gateway-health");
  });

  it.each(["start", "health"] as const)("fails closed when active gateway restoration fails at %s", (failure) => {
    const result = runLlamaTransactionHarness("apply", true, failure);
    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("verify");
    expect(result.output).not.toContain("private-locator");
  });

  it("uses original pre-apply evidence when rollback follows a failed llama-swap apply", () => {
    const result = runLlamaTransactionHarness("failed-apply-rollback", true);
    expect(result.status, result.output).toBe(0);
    expect(result.log).toContain("apply-failed");
    expect(result.log).toContain("gateway-start");
    expect(result.log).toContain("gateway-health");
    expect(result.log.indexOf("gateway-start")).toBeGreaterThan(result.log.indexOf("apply-failed"));
    expect(result.log.indexOf("gateway-health")).toBeLessThan(result.log.indexOf("success"));
  });

  it("rejects invalid pre-apply dependency evidence before mutating rollback state", () => {
    const result = runLlamaTransactionHarness("failed-apply-invalid-evidence-rollback", true);
    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("llama-stop");
    expect(result.log).not.toContain("success");
    expect(result.output).toContain("state evidence is invalid");
    expect(result.output).not.toContain("private-locator");
  });

  it("reuses pre-rollback evidence when a failed rollback is retried", () => {
    const result = runLlamaTransactionHarness("failed-rollback-retry", true);
    expect(result.status, result.output).toBe(0);
    expect(result.log).toContain("rollback-failed");
    expect(result.log).toContain("gateway-start");
    expect(result.log).toContain("gateway-health");
    expect(result.log.indexOf("gateway-start")).toBeGreaterThan(result.log.indexOf("rollback-failed"));
    expect(result.log.indexOf("gateway-health")).toBeLessThan(result.log.indexOf("success"));
  });
});
