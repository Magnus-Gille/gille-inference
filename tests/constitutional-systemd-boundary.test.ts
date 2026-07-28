import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../deploy/systemd/", import.meta.url).pathname;
const deployRoot = new URL("../deploy/", import.meta.url).pathname;
const recoveryEntrypoint = readFileSync(
  new URL("../scripts/constitutional-recovery-service.ts", import.meta.url),
  "utf8",
);
const unit = (name: string) => readFileSync(join(root, name), "utf8");

describe("rendered constitutional systemd capability boundary", () => {
  it("uses three distinct service UIDs with root-owned authority read-only", () => {
    const controller = unit("gille-constitutional-controller.service");
    const watchdog = unit("gille-constitutional-watchdog.service");
    const recovery = unit("gille-constitutional-recovery.service");
    expect(controller).toContain("User=gille-autonomy-controller");
    expect(watchdog).toContain("User=gille-autonomy-watchdog");
    expect(recovery).toContain("User=gille-autonomy-recovery");
    expect(controller).toContain("SupplementaryGroups=gille-autonomy-state");
    expect(controller).not.toContain("gille-routing-writers");
    expect(watchdog).toContain("SupplementaryGroups=gille-autonomy-state");
    expect(watchdog).not.toContain("gille-routing-writers");
    expect(recovery).toContain("SupplementaryGroups=gille-autonomy-state gille-routing-writers");
    expect(controller).toContain("UMask=0007");
    expect(watchdog).toContain("UMask=0007");
    expect(controller).toContain("RuntimeMaxSec=120");
    expect(watchdog).toContain("RuntimeMaxSec=120");
    for (const rendered of [controller, watchdog, recovery]) {
      expect(rendered).toContain("ProtectSystem=strict");
      expect(rendered).toContain("ProtectClock=true");
      expect(rendered).toContain("ReadOnlyPaths=/etc/gille-inference/autonomy");
      expect(rendered).toContain("RestrictAddressFamilies=AF_UNIX");
      expect(rendered).not.toMatch(/%h\/\.config/);
    }
  });

  it("assigns registration and action sockets to different OS groups", () => {
    const registration = unit("gille-constitutional-recovery-register.socket");
    const action = unit("gille-constitutional-recovery-action.socket");
    expect(registration).toContain("SocketGroup=gille-autonomy-controller");
    expect(action).toContain("SocketGroup=gille-autonomy-watchdog");
    expect(registration).toContain("SocketMode=0660");
    expect(action).toContain("SocketMode=0660");
    expect(registration).toContain("DirectoryMode=0755");
    expect(action).toContain("DirectoryMode=0755");
    expect(registration).not.toContain("gille-autonomy-watchdog");
    expect(action).not.toContain("gille-autonomy-controller");
  });

  it("denies controller/watchdog access to recovery state and denies watchdog direct target writes", () => {
    const controller = unit("gille-constitutional-controller.service");
    const watchdog = unit("gille-constitutional-watchdog.service");
    const recovery = unit("gille-constitutional-recovery.service");
    expect(controller).not.toContain("ReadWritePaths=/var/lib/gille-inference/autonomy-recovery");
    expect(controller).toContain("InaccessiblePaths=/var/lib/gille-inference/routing");
    expect(watchdog).toContain("ReadOnlyPaths=/var/lib/gille-inference/routing");
    expect(watchdog).not.toContain("ReadWritePaths=/var/lib/gille-inference/routing");
    expect(recovery).toContain("ReadWritePaths=/var/lib/gille-inference/autonomy-recovery");
    expect(recovery).toContain("ReadWritePaths=/var/lib/gille-inference/routing");
    expect(recovery).toContain("ReadOnlyPaths=/var/lib/gille-inference/autonomy");
    expect(controller).toContain("InaccessiblePaths=/var/lib/gille-inference/autonomy-recovery");
    expect(watchdog).toContain("InaccessiblePaths=/var/lib/gille-inference/autonomy-recovery");
  });

  it("keeps scheduler and watchdog as separate timers", () => {
    expect(unit("gille-constitutional-controller.timer")).toContain("OnUnitActiveSec=30s");
    expect(unit("gille-constitutional-watchdog.timer")).toContain("OnUnitActiveSec=60s");
    expect(unit("gille-constitutional-controller.service")).toContain("constitutional-routing-cli.ts controller");
    expect(unit("gille-constitutional-watchdog.service")).toContain("constitutional-routing-cli.ts watchdog");
  });

  it("cannot bypass the absent owner-installed sign-and-persist prerequisite", () => {
    const recovery = unit("gille-constitutional-recovery.service");
    expect(recovery).toContain("ConditionPathExists=/etc/gille-inference/autonomy/recovery-config.json");
    expect(recoveryEntrypoint).toContain('Object.keys(recoveryConfig).sort().join(",") !== "recovery_signer_bin"');
    expect(recoveryEntrypoint).toContain("assertRecoverySignerReady(recoveryConfig.recovery_signer_bin, 0)");
    expect(recoveryEntrypoint.indexOf("assertRecoverySignerReady(recoveryConfig.recovery_signer_bin, 0)"))
      .toBeLessThan(recoveryEntrypoint.indexOf("await startRecoveryService"));
  });

  it("ships closed schemas with the same fixed production targets as the composition root", () => {
    const authority = JSON.parse(readFileSync(join(deployRoot, "constitutional-authority-config-v1.schema.json"), "utf8"));
    const recovery = JSON.parse(readFileSync(join(deployRoot, "constitutional-recovery-config-v1.schema.json"), "utf8"));
    expect(authority.additionalProperties).toBe(false);
    expect(authority.properties.canonical_state_dir.const).toBe("/var/lib/gille-inference/autonomy");
    expect(authority.properties.canonical_route_table_path.const).toBe("/var/lib/gille-inference/routing/m5-routing.db");
    expect(authority.properties.canonical_plan_path.const).toBe("/var/lib/gille-inference/autonomy/immutable-plan.json");
    expect(authority.required).toEqual(Object.keys(authority.properties));
    expect(recovery).toMatchObject({
      additionalProperties: false,
      required: ["recovery_signer_bin"],
    });
  });
});
