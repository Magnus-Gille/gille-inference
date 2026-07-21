#!/usr/bin/env bash
set -euo pipefail

# scripts/deploy-gateway.sh — deploy/verify the M5 home-inference gateway (issue #23).
#
# Ground truth verified live on 2026-07-19/20 (see deploy/README.md's "Live deployment
# (authoritative)" section, which this script implements):
#   - systemd unit: home-gateway.service, WorkingDirectory=/home/magnus/home-server-eval,
#     ExecStart=<WorkingDirectory>/node_modules/.bin/tsx src/homeserver/cli.ts serve.
#   - the live tree is a plain rsync'd copy, NOT a git checkout — there is no `.git` to inspect
#     on the box, so the deployed identity is whatever this script stamps into .deployed-commit.
#   - the gateway binds the box's tailnet interface (HOMESERVER_HOST), not loopback-only.
#     Unauthenticated routes (/healthz, /portal*, /portal/redeem, /portal/stats,
#     /portal/model-evals.json) are reachable there; every other route still requires a
#     `Authorization: Bearer` key (src/homeserver/README.md's Gateway API table is authoritative
#     for the per-route auth tier). This script never hardcodes the tailnet address — callers
#     supply it via DEPLOY_HEALTH_TAILNET_URL / DEPLOY_CAPABILITY_URL.
#   - the gateway process also serves /mcp; restarting it drops live MCP transports (Claude
#     Code / Codex reconnect on next call). Async code_loop jobs survive a restart via the
#     durable SQLite store (see docs/agentic-code-tool-design.md).
#
# Modes (first positional arg):
#   deploy    (default) Sync the clean reviewed source tree to the verified remote
#             WorkingDirectory, seed docs/m5-routing.json copy-if-absent (never clobbering an
#             adopted table — issue #44), restart the unit only if the payload actually changed
#             (gated by an interpreter preflight — issue #30), probe local + tailnet health plus
#             an authenticated capability check, and — only once ALL of that has passed — render
#             and enable the repo-managed user-scope gille-autonomy-tick.timer (gi#49;
#             deploy/systemd/*.{service,timer}, mirrors hugin's in-repo-units convention; armed
#             LAST, immediately before the marker write, so a Persistent=true catch-up tick can
#             never fire against a gateway that is still mid-restart), then stamp
#             .deployed-commit with the exact 40-char SHA ONLY after every check passes.
#   verify    Read-only. Reports the marker commit plus a content spot-check against the local
#             tree. Never touches rsync, the unit, or the marker.
#   dry-run   Prints the exact plan (path check, rsync command, restart decision, probes) without
#             running rsync, restarting the unit, or writing the marker. Still performs the
#             READ-ONLY remote WorkingDirectory check by default, so a path mismatch is caught
#             before a real deploy would hit it; set DEPLOY_DRY_RUN_OFFLINE=1 to skip even that
#             (fully offline plan, e.g. to review the rsync command with no network at all).
#
# Fail-closed safety contract (mirrors hugin/scripts/deploy-pi.sh's marker discipline):
#   - refuses a dirty or non-addressable source tree before any network access;
#   - refuses when the remote unit's WorkingDirectory does not match DEPLOY_REMOTE_DIR — never
#     silently targets a stale or guessed path;
#   - invalidates any existing .deployed-commit as the FIRST remote mutation, so every failure
#     after that point leaves the marker ABSENT rather than stale-but-plausible;
#   - never overwrites a live docs/m5-routing.json: it is excluded from the main rsync (like
#     .env/data/) and only ever seeded with --ignore-existing, so an adopted routing table (the
#     #7 routing-lifecycle CLI's runtime state) survives every deploy; a fresh box with no table
#     still gets the committed one (issue #44);
#   - refuses to restart the unit if the ExecStart interpreter is missing/non-executable after
#     install — the exact failure mode of `npm ci --omit=dev` stripping the tsx runtime
#     dependency (issue #30) — instead of restarting into a crash-loop;
#   - renders gille-autonomy-tick.timer's WorkingDirectory/ExecStart against the ACTUAL verified
#     $remote_dir (never a hardcoded path), refuses to arm it if its tsx interpreter is missing,
#     and refuses to arm it if the account isn't (and can't be made) lingering — a failure at any
#     of those gates is a hard deploy ERROR (gi#49), not a silent skip, because an un-enabled or
#     non-lingering timer means the autonomy controller silently stops ticking;
#   - arms that timer LAST, strictly after restart-if-needed and every health/capability probe
#     have already succeeded, so a Persistent=true catch-up tick can never fire against a gateway
#     that is still mid-restart;
#   - writes the new marker as the truly final step, only once rsync, install, the interpreter
#     preflight, restart-if-needed, local health (best-effort), tailnet health, the authenticated
#     capability probe, and the autonomy-tick timer render/enable have all succeeded.
#
# Test seam (see tests/deploy-gateway.test.ts): every "remote" step is issued through
# remote_run(), which resolves an overridable env var to a command string and executes it via
# remote_exec(). remote_exec() runs the command over `ssh "$DEPLOY_REMOTE_HOST"` when
# DEPLOY_REMOTE_HOST is set, or locally via `bash -c` when it is empty — and rsync's destination
# collapses from `host:path` to a bare local path in the same case. Tests leave
# DEPLOY_REMOTE_HOST empty and point DEPLOY_REMOTE_DIR at a disposable local fixture directory,
# so the exact same code path that would ssh to the real box instead runs entirely offline. No
# test may set DEPLOY_REMOTE_HOST to a real host or otherwise cause a network call to production.

DEPLOY_REMOTE_HOST="${DEPLOY_REMOTE_HOST-m5}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/magnus/home-server-eval}"
DEPLOY_UNIT="${DEPLOY_UNIT:-home-gateway.service}"
# issue #30: the gateway binds ONLY the tailnet interface (HOMESERVER_HOST), never loopback (that
# is the whole reason DEPLOY_HEALTH_TAILNET_URL exists below and has no safe default). A default
# of http://127.0.0.1:8080/healthz therefore probed a listener that was never going to answer,
# blocking every deploy on an unfixable false negative. The local probe now defaults to UNSET and
# is best-effort/non-blocking (see probe_health's `required` argument): set it explicitly only if
# something legitimately listens on loopback in your environment (e.g. local dev). The mandatory,
# always-required probe of the box's real listener is DEPLOY_HEALTH_TAILNET_URL, unchanged.
DEPLOY_HEALTH_LOCAL_URL="${DEPLOY_HEALTH_LOCAL_URL:-}"
DEPLOY_HEALTH_TAILNET_URL="${DEPLOY_HEALTH_TAILNET_URL:-}"
DEPLOY_CAPABILITY_URL="${DEPLOY_CAPABILITY_URL:-}"
DEPLOY_CAPABILITY_KEY_ENV="${DEPLOY_CAPABILITY_KEY_ENV:-HOMESERVER_OWNER_KEY}"
DEPLOY_FORCE_RESTART="${DEPLOY_FORCE_RESTART:-0}"

# Default spot-check set for `verify`: files whose content on the box was hash-compared against
# canonical/main during the #20 deploy that established the 8caf400 baseline. Override with a
# space-separated list in DEPLOY_SPOT_CHECK_FILES if a different pair is more useful later.
if [ -n "${DEPLOY_SPOT_CHECK_FILES:-}" ]; then
  # shellcheck disable=SC2206 # intentional word-splitting of an operator-supplied list
  SPOT_CHECK_FILES=(${DEPLOY_SPOT_CHECK_FILES})
else
  SPOT_CHECK_FILES=(src/homeserver/learning-task-contract.ts src/homeserver/gateway.ts)
fi

# rsync excludes and why each one is safety- or correctness-critical:
#   .git/            the live tree is intentionally not a git checkout; never ship repo metadata.
#   node_modules/     better-sqlite3 is a native module; a mac/arm64 build shipped to the Linux
#                     box would be a broken binary. `npm ci --omit=dev` runs on the remote instead
#                     (see DEPLOY_INSTALL_CMD below) — mirrors hugin/scripts/deploy-pi.sh.
#   .env, .env.*      secrets/config live only on the box; never overwrite or exfiltrate them.
#   data/             the live SQLite stores (keystore, ledger, request_log, image jobs, ...) and
#                     any scratch/harvest output. Losing this is losing production state.
#   *.db / *.sqlite*  belt-and-braces in case a DB file ever lives outside data/.
#   *.log             operational logs are box-local, not part of the reviewed payload.
#   .deployed-commit* managed exclusively by this script's invalidate/write steps, never by rsync.
#   docs/m5-routing.json  runtime state, NOT reviewed-payload content (issue #44): the #7
#                     routing-lifecycle CLI's `adopt` command writes a human-approved routing
#                     table into this exact path on the live box. It is still git-tracked (it also
#                     doubles as the first-deploy SEED), so excluding it from the main sync is what
#                     stops every later deploy from silently reverting an adoption back to whatever
#                     happens to be committed. `seed_routing_table()` below (rsync --ignore-existing
#                     on this one path, run AFTER the main sync) is the copy-if-absent half: a box
#                     that has no table yet gets the committed one; a box with any existing table —
#                     adopted or not — is never touched.
#   .DS_Store         macOS noise from the operator's laptop.
#   .claude/ .codex/  local agent-harness scratch, never shipped.
#   dist/             no build step ships to the box today (tsx runs src/ directly); if that ever
#                     changes, drop this exclude in the same change that adds a build step.
# rsync's default --delete does NOT remove files matched by an --exclude (that needs the separate
# --delete-excluded flag, which is deliberately never passed here), so data/.env/node_modules/the
# routing table on the box survive a delete pass even though the source tree here doesn't have
# matching content.
RSYNC_EXCLUDES=(
  --exclude .git --exclude .git/
  --exclude node_modules --exclude node_modules/
  --exclude .env --exclude '.env.*'
  --exclude data/
  --exclude '*.db' --exclude '*.sqlite' --exclude '*.sqlite3'
  --exclude '*.sqlite-wal' --exclude '*.sqlite-shm'
  --exclude '*.log'
  --exclude .deployed-commit --exclude .deployed-commit.tmp
  --exclude docs/m5-routing.json
  --exclude .DS_Store
  --exclude .claude/ --exclude .codex/
  --exclude dist/
)

# ── low-level plumbing ──────────────────────────────────────────────────────────────────────

# Run a command "on the remote" — over ssh when DEPLOY_REMOTE_HOST is set, or locally when it is
# empty (the test seam). Every caller goes through remote_run() below, never this directly, so
# every step stays independently overridable.
remote_exec() {
  if [ -n "$DEPLOY_REMOTE_HOST" ]; then
    # SC2029: client-side expansion is intentional here — the command string is built by this
    # script's own trusted callers (remote_run's default commands, all quoting their own
    # variables), never from untrusted input. Same idiom as hugin/scripts/deploy-pi.sh.
    # shellcheck disable=SC2029
    ssh "$DEPLOY_REMOTE_HOST" "$1"
  else
    bash -c "$1"
  fi
}

# remote_run VAR_NAME "default command" — resolve $VAR_NAME if set (test/operator override),
# else use the default, then execute it via remote_exec. Centralizing every remote step through
# this one function is what lets tests stub systemctl/npm/sudo without touching ssh at all.
remote_run() {
  local override_var="$1" default_cmd="$2" cmd
  cmd="${!override_var:-$default_cmd}"
  remote_exec "$cmd"
}

# Destination argument for rsync: "host:dir/" normally, or a bare "dir/" in the local test seam
# (rsync itself needs no ssh/network for a local-to-local copy).
rsync_dest() {
  if [ -n "$DEPLOY_REMOTE_HOST" ]; then
    printf '%s:%s/' "$DEPLOY_REMOTE_HOST" "$DEPLOY_REMOTE_DIR"
  else
    printf '%s/' "$DEPLOY_REMOTE_DIR"
  fi
}

# Refuse a symlinked local node_modules (the common worktree-sharing optimization) before rsync
# ever runs: rsync distinguishes a real directory from a symlink-to-directory, so the trailing-
# slash node_modules exclude above would silently fail to match it, and this script would ship a
# potentially-wrong-platform node_modules straight through. Mirrors hugin/scripts/deploy-pi.sh.
refuse_symlinked_node_modules() {
  if [ -L node_modules ]; then
    echo "ERROR: local node_modules is a symlink; refusing to deploy." >&2
    echo "       Replace it with worktree-local dependencies, e.g.: unlink node_modules && npm ci" >&2
    return 1
  fi
}

# Print the exact 40-char HEAD commit SHA iff the source tree is an addressable, clean git
# checkout rooted at the current directory. Fails closed (dirty-source / detached-blob / wrong-cwd
# refusal) — verbatim in spirit to hugin/scripts/deploy-pi.sh's read_clean_deploy_sha.
read_clean_deploy_sha() {
  local repo_root source_status source_sha
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "ERROR: deploy source is not an addressable Git checkout." >&2
    return 1
  fi
  if [ "$(pwd -P)" != "$(cd "$repo_root" && pwd -P)" ]; then
    echo "ERROR: run deploy-gateway.sh from the gille-inference repository root." >&2
    return 1
  fi
  if ! source_sha="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
    [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: deploy source HEAD is not an addressable full commit." >&2
    return 1
  fi
  if ! source_status="$(git status --porcelain=v1 --untracked-files=normal)"; then
    echo "ERROR: could not verify deploy-source cleanliness." >&2
    return 1
  fi
  if [ -n "$source_status" ]; then
    echo "ERROR: deploy source must be clean; refusing to stamp uncommitted content." >&2
    printf '%s\n' "$source_status" >&2
    return 1
  fi
  printf '%s\n' "$source_sha"
}

# ── remote probes ───────────────────────────────────────────────────────────────────────────

remote_working_directory() {
  remote_run DEPLOY_WORKDIR_PROBE_CMD "systemctl show '$DEPLOY_UNIT' --property=WorkingDirectory --value"
}

# Fail-closed path guard (issue #23's core acceptance criterion): read the *live* unit's
# WorkingDirectory and refuse everything else if it doesn't match what we're about to sync into.
# Prints the matched path on stdout on success; nothing on failure (caller checks exit status).
verify_path_match() {
  local remote_dir expected
  if ! remote_dir="$(remote_working_directory)"; then
    echo "ERROR: could not read $DEPLOY_UNIT's WorkingDirectory (host: ${DEPLOY_REMOTE_HOST:-<local test seam>})." >&2
    return 1
  fi
  remote_dir="$(printf '%s' "$remote_dir" | tr -d '[:space:]')"
  expected="${DEPLOY_REMOTE_DIR%/}"
  if [ -z "$remote_dir" ]; then
    echo "ERROR: $DEPLOY_UNIT reported an empty WorkingDirectory — refusing to deploy." >&2
    return 1
  fi
  if [ "${remote_dir%/}" != "$expected" ]; then
    echo "ERROR: $DEPLOY_UNIT's live WorkingDirectory ($remote_dir) does not match the configured" >&2
    echo "       deploy target ($expected). Refusing to deploy against a mismatched/guessed path." >&2
    echo "       If $remote_dir is now correct, re-run with DEPLOY_REMOTE_DIR=$remote_dir." >&2
    return 1
  fi
  printf '%s\n' "${remote_dir%/}"
}

# probe_health URL LABEL [REQUIRED=1] — REQUIRED=0 (used for the "local" probe by default, issue
# #30) means an unset URL is reported and skipped rather than refusing the deploy: the gateway
# binds only the tailnet interface, so a default loopback probe can never legitimately answer, and
# treating that as a hard failure blocked every deploy on an unfixable false negative. REQUIRED=1
# (the default, and always used for "tailnet") keeps refusing when unset — that probe targets the
# box's real listener and staying mandatory is exactly what issue #23 established.
probe_health() {
  local url="$1" label="$2" required="${3:-1}"
  if [ -z "$url" ]; then
    if [ "$required" = "1" ]; then
      echo "ERROR: $label health URL is not set — refusing to certify deployment without probing it." >&2
      return 1
    fi
    echo "  SKIP: $label health probe not configured (expected-per-config; not deploy-blocking, issue #30)"
    return 0
  fi
  if ! curl -fsS --max-time 10 "$url" >/dev/null; then
    echo "ERROR: $label health probe failed: $url" >&2
    return 1
  fi
  echo "  OK: $label healthy ($url)"
}

# Copy-if-absent seed for the routing table (issue #44): a plain rsync of this ONE path with
# --ignore-existing, run AFTER the main sync (which excludes it wholesale, see RSYNC_EXCLUDES).
# rsync's own --ignore-existing does exactly the semantics this needs and nothing more: if the
# destination file does not exist, it is created from the committed copy (the fresh-box SEED
# case); if it already exists — freshly seeded on a prior deploy, or holding a human-adopted table
# from the #7 routing-lifecycle CLI — rsync silently skips it. No existence-check-then-copy TOCTOU
# window, no separate remote command, and it works identically in the ssh and local test-seam
# modes because it goes through the exact same rsync_dest() the main sync already uses.
seed_routing_table() {
  local out
  if [ ! -f docs/m5-routing.json ]; then
    # Should not happen against a real checkout (it is always git-tracked) but fail SOFT here:
    # a missing local seed file is a repo-consistency problem, not a reason to abort an otherwise
    # good deploy of everything else.
    echo "  WARN: no local docs/m5-routing.json to seed from -- skipping (nothing to install)."
    return 0
  fi
  out="$(rsync -a --ignore-existing -i docs/m5-routing.json "$(rsync_dest)docs/m5-routing.json")"
  if [ -n "$out" ]; then
    echo "  SEEDED: docs/m5-routing.json was absent on the remote -- installed the committed table."
  else
    echo "  OK: docs/m5-routing.json already present on the remote -- left untouched (adopted tables are never overwritten)."
  fi
}

# Resolve the live unit's ExecStart interpreter path (issue #30's pre-restart preflight). Parsed
# from `systemctl show --property=ExecStart --value`, whose value looks like:
#   { path=/abs/path/node_modules/.bin/tsx ; argv[]=/abs/path/.../tsx src/homeserver/cli.ts serve ; ... }
# Parameter-expansion only (no grep -P / PCRE) so this runs identically under GNU and BSD toolchains.
remote_execstart_path() {
  local raw
  raw="$(remote_run DEPLOY_EXECSTART_PROBE_CMD "systemctl show '$DEPLOY_UNIT' --property=ExecStart --value")" || return 1
  raw="${raw#*path=}"
  raw="${raw%%;*}"
  raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
  printf '%s\n' "$raw"
}

# Fail-closed guard (issue #30): refuse to restart the unit if the ExecStart interpreter is
# missing or not executable after install. This is the exact failure mode of `npm ci --omit=dev`
# stripping tsx (a devDependency that is also the production runtime) — the old default silently
# restarted into a 203/EXEC crash-loop. Run this immediately before every restart, never before.
preflight_interpreter() {
  local exec_path
  exec_path="$(remote_execstart_path)" || {
    echo "ERROR: could not read $DEPLOY_UNIT's ExecStart -- refusing to restart without confirming its interpreter exists." >&2
    return 1
  }
  if [ -z "$exec_path" ]; then
    echo "ERROR: $DEPLOY_UNIT's ExecStart has no parseable interpreter path -- refusing to restart." >&2
    return 1
  fi
  if ! remote_run DEPLOY_INTERPRETER_CHECK_CMD "test -x '$exec_path'"; then
    echo "ERROR: $DEPLOY_UNIT's ExecStart interpreter ($exec_path) is missing or not executable after" >&2
    echo "       install -- refusing to restart (issue #30: this is exactly what 'npm ci --omit=dev'" >&2
    echo "       stripping the tsx runtime dependency looks like). Fix the install step and re-run;" >&2
    echo "       the unit is left running its last-good build, not restarted into a crash-loop." >&2
    return 1
  fi
  echo "  OK: ExecStart interpreter present and executable ($exec_path)"
}

# Install/enable the repo-managed user-scope systemd units (gi#49: the daily autonomy-controller
# tick, docs: deploy/systemd/gille-autonomy-tick.{service,timer}) — mirrors hugin's convention of
# keeping unit files in-repo as IaC rather than hand-authored on the box. Called from cmd_deploy
# ONLY after rsync, install, restart-if-needed, local/tailnet health, and the capability probe have
# ALL already succeeded (see the call site) — arming the timer any earlier risks a Persistent=true
# catch-up tick firing against a gateway that is mid-restart. Five sub-steps, each fail-closed:
#
#   1. Render + copy: deploy/systemd/gille-autonomy-tick.service is a TEMPLATE (placeholder
#      @@REMOTE_DIR@@, never a real path) — a hardcoded WorkingDirectory/ExecStart in the
#      committed file would bypass this very script's own path guard (verify_path_match) the
#      moment the live WorkingDirectory ever changes. This step substitutes the ACTUAL, just-
#      verified $remote_dir via sed into the installed copy under $HOME/.config/systemd/user/, so
#      the running unit always points at the tree this deploy just verified and shipped. The main
#      rsync already put the template at "$remote_dir/deploy/systemd/*.{service,timer}" (that path
#      is not in RSYNC_EXCLUDES); the .timer has no path to substitute and is copied verbatim.
#      Deliberately kept separate from step 2's daemon-reload (its own override var) so tests can
#      exercise the real file-substitution logic without depending on a real `systemctl` being
#      present at all (e.g. under macOS or a container with no systemd --user session).
#   2. Daemon-reload, now that the (possibly new/changed) unit files are in place.
#   3. Interpreter existence check: reuses the EXACT same idiom (and override var,
#      DEPLOY_INTERPRETER_CHECK_CMD) as preflight_interpreter's issue #30 check above, against the
#      identical binary ("$remote_dir/node_modules/.bin/tsx" — the ExecStart no longer goes through
#      `/usr/bin/env npx`, which can silently resolve differently, or not at all, under the
#      systemd --user manager's PATH vs. an interactive SSH PATH/nvm/asdf shim).
#   4. Lingering check: `systemctl --user enable --now` succeeding over THIS ssh/local session
#      proves nothing once the session ends — without lingering enabled for the account, the user
#      manager (and every unit in it, including this timer) is torn down at logout, and the 05:30
#      tick silently never fires even though the deploy already stamped success. Attempts the
#      (usually unprivileged) `loginctl enable-linger` first; if the account still isn't lingering
#      afterward, fails closed with the exact remediation command rather than certifying a timer
#      that will never actually run unattended.
#   5. Enable + start: only once 1-4 have all succeeded.
#
# Every sub-step is routed through remote_run (its own override var) so tests can stub each
# independently, exactly like every other remote step in this script.
install_user_units() {
  local remote_dir="$1"
  local tsx_path="$remote_dir/node_modules/.bin/tsx"

  # 1. Render (substitute @@REMOTE_DIR@@ -> $remote_dir) + copy. `\$HOME` below is deliberate:
  # within this double-quoted string, backslash-dollar collapses to a literal, unescaped `$HOME`
  # in the assembled command, which must be expanded by the remote/local shell that actually
  # EXECUTES it (where $HOME is meaningful) — never by this script's own shell substituting a
  # path resolved against the wrong box/session. Do not single-quote it.
  if ! remote_run DEPLOY_UNITS_RENDER_CMD \
    "mkdir -p \$HOME/.config/systemd/user && sed 's|@@REMOTE_DIR@@|$remote_dir|g' '$remote_dir/deploy/systemd/gille-autonomy-tick.service' > \$HOME/.config/systemd/user/gille-autonomy-tick.service && cp '$remote_dir/deploy/systemd/gille-autonomy-tick.timer' \$HOME/.config/systemd/user/gille-autonomy-tick.timer"; then
    echo "ERROR: failed to render/install gille-autonomy-tick unit files (gi#49) -- refusing to" >&2
    echo "       certify deployment with the autonomy-tick units possibly missing/stale." >&2
    return 1
  fi

  # 2. Daemon-reload, now that the (possibly new/changed) unit files are in place.
  if ! remote_run DEPLOY_UNITS_RELOAD_CMD "systemctl --user daemon-reload"; then
    echo "ERROR: 'systemctl --user daemon-reload' failed after installing gille-autonomy-tick" >&2
    echo "       unit files (gi#49) -- refusing to certify deployment with a stale user manager." >&2
    return 1
  fi

  # 3. Interpreter existence check (issue #30 idiom reused verbatim).
  if ! remote_run DEPLOY_INTERPRETER_CHECK_CMD "test -x '$tsx_path'"; then
    echo "ERROR: gille-autonomy-tick.timer's tsx interpreter ($tsx_path) is missing or not" >&2
    echo "       executable -- refusing to enable the timer (gi#49)." >&2
    return 1
  fi

  # 4. Lingering check. The whole pipeline's exit status is the final `loginctl show-user` check,
  # so this is TRUE iff the account ends up lingering, regardless of whether enable-linger itself
  # was needed/succeeded. No local variables to substitute -- entirely remote-side, hence the
  # single-quoted literal (verbatim $ signs, no local expansion).
  # shellcheck disable=SC2016 # intentional: expands on the REMOTE/local-test-seam shell that runs
  # this string via remote_exec, not this script's own shell -- same idiom as \$HOME above.
  if ! remote_run DEPLOY_LINGER_CHECK_CMD \
    'u="$(id -un)"; loginctl show-user "$u" --property=Linger 2>/dev/null | grep -q "^Linger=yes$" || loginctl enable-linger "$u" >/dev/null 2>&1; loginctl show-user "$u" --property=Linger 2>/dev/null | grep -q "^Linger=yes$"'; then
    echo "ERROR: user lingering is not enabled for this account -- gille-autonomy-tick.timer would" >&2
    echo "       be torn down at SSH/session logout and the 05:30 tick would never fire unattended." >&2
    echo "       Run on the box, then re-run this deploy:" >&2
    echo "         loginctl enable-linger \$(id -un)" >&2
    return 1
  fi

  # 5. Arm the timer. `enable --now` is idempotent -- a no-op on an already-enabled, already-
  # running timer -- so this is safe to run unconditionally on every deploy.
  if ! remote_run DEPLOY_UNITS_ENABLE_CMD "systemctl --user enable --now gille-autonomy-tick.timer"; then
    echo "ERROR: failed to enable gille-autonomy-tick.timer (gi#49) -- refusing to certify" >&2
    echo "       deployment with the autonomy tick un-enabled." >&2
    return 1
  fi
  echo "  OK: gille-autonomy-tick.timer rendered, interpreter verified, lingering confirmed, and enabled"
}

# Authenticated capability smoke test. Reads the bearer key from an env var (name configurable
# via DEPLOY_CAPABILITY_KEY_ENV) and NEVER echoes, logs, or includes it in any printed command —
# only the resulting HTTP status code is reported. This is the credential-safe authenticated
# check the issue asks for; it hits /v1/capabilities/learning-task, which is cheap (no model call)
# and proves the auth + admission spine actually accepted the key, not just that /healthz answers.
probe_capability() {
  local url="${DEPLOY_CAPABILITY_URL}" key_env="${DEPLOY_CAPABILITY_KEY_ENV}" key code
  if [ -z "$url" ]; then
    echo "ERROR: DEPLOY_CAPABILITY_URL is not set — refusing to certify deployment without an" >&2
    echo "       authenticated capability probe (never pass the bearer key on the command line)." >&2
    return 1
  fi
  key="${!key_env:-}"
  if [ -z "$key" ]; then
    echo "ERROR: \$$key_env is not set — cannot run the authenticated capability probe." >&2
    return 1
  fi
  code="$(curl -fsS --max-time 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${key}" "$url" 2>/dev/null || true)"
  if [ "$code" != "200" ]; then
    echo "ERROR: authenticated capability probe returned HTTP ${code:-<no response>}." >&2
    return 1
  fi
  echo "  OK: authenticated capability probe passed ($url -> 200)"
}

# ── modes ────────────────────────────────────────────────────────────────────────────────────

cmd_dry_run() {
  local sha remote_dir
  sha="$(read_clean_deploy_sha)" || return 1
  echo "PLAN: would deploy commit $sha"
  if [ "${DEPLOY_DRY_RUN_OFFLINE:-0}" = 1 ]; then
    echo "PLAN: DEPLOY_DRY_RUN_OFFLINE=1 -- skipping the (read-only) remote WorkingDirectory check."
  else
    if remote_dir="$(verify_path_match)"; then
      echo "PLAN: remote WorkingDirectory verified: $remote_dir"
    else
      echo "PLAN: remote WorkingDirectory check FAILED -- a real deploy would refuse here."
      return 1
    fi
  fi
  echo "PLAN: rsync -a --delete -i ${RSYNC_EXCLUDES[*]} ./ $(rsync_dest)"
  echo "PLAN: seed docs/m5-routing.json copy-if-absent (rsync --ignore-existing; never overwrites an adopted table -- issue #44)"
  echo "PLAN: remote install: ${DEPLOY_INSTALL_CMD:-cd '<remote_dir>' && npm ci --omit=dev}"
  echo "PLAN: if restarting: preflight the ExecStart interpreter first, refuse the restart if it is missing (issue #30)"
  echo "PLAN: restart $DEPLOY_UNIT only if rsync reports changes (or DEPLOY_FORCE_RESTART=1)"
  echo "PLAN: probe local health at ${DEPLOY_HEALTH_LOCAL_URL:-<unset - best-effort/non-blocking, issue #30>}"
  echo "PLAN: probe tailnet health at ${DEPLOY_HEALTH_TAILNET_URL:-<unset - required for a real deploy>}"
  echo "PLAN: authenticated capability probe at ${DEPLOY_CAPABILITY_URL:-<unset - required for a real deploy>}"
  echo "PLAN: LAST, only after every check above passes: render gille-autonomy-tick.service (gi#49) against the verified remote dir, verify its tsx interpreter, confirm/enable user lingering, then 'systemctl --user enable --now gille-autonomy-tick.timer' (idempotent; any failure is a deploy ERROR, no marker)"
  echo "PLAN: write .deployed-commit=$sha only after every step above passes"
}

cmd_verify() {
  local remote_dir marker f local_hash remote_hash status=0
  remote_dir="$(verify_path_match)" || return 1
  echo "WorkingDirectory: $remote_dir"
  marker="$(remote_run DEPLOY_READ_MARKER_CMD "cat '$remote_dir/.deployed-commit' 2>/dev/null || true")"
  marker="$(printf '%s' "$marker" | tr -d '[:space:]')"
  if [ -z "$marker" ]; then
    echo "STATUS: no .deployed-commit marker present -- deployed identity is unknown."
    return 1
  fi
  if [[ ! "$marker" =~ ^[0-9a-f]{40}$ ]]; then
    echo "STATUS: .deployed-commit does not contain a 40-char SHA ('$marker') -- treating as unknown."
    return 1
  fi
  echo "Marker commit: $marker"
  for f in "${SPOT_CHECK_FILES[@]}"; do
    if ! git cat-file -e "$marker:$f" 2>/dev/null; then
      echo "  WARN: local checkout has no object for $f @ $marker -- skipping (fetch that commit?)"
      continue
    fi
    local_hash="$(git show "$marker:$f" | shasum -a 256 | awk '{print $1}')"
    # `|| true` is load-bearing, not decorative: under `set -o pipefail`, a genuinely missing
    # remote file makes both shasum and sha256sum fail, so the pipeline exits non-zero: assigned
    # via "$(...)" under `set -e`, that would abort cmd_verify (and the whole process) on the
    # spot instead of reaching the empty-remote_hash WARN branch below. `|| true` keeps a missing
    # file a graceful per-file WARN, matching a regression test in tests/deploy-gateway.test.ts.
    remote_hash="$(remote_run DEPLOY_HASH_CMD "shasum -a 256 '$remote_dir/$f' 2>/dev/null || sha256sum '$remote_dir/$f' 2>/dev/null" | awk '{print $1}' || true)"
    if [ -z "$remote_hash" ]; then
      echo "  WARN: could not hash remote $f (missing on the box?)"
      status=1
      continue
    fi
    if [ "$local_hash" = "$remote_hash" ]; then
      echo "  OK: $f content matches marker commit $marker"
    else
      echo "  MISMATCH: $f differs from marker commit $marker (stale marker or hand-edited file)."
      status=1
    fi
  done
  return "$status"
}

cmd_deploy() {
  local sha remote_dir rsync_out post_sha payload_changed=0

  refuse_symlinked_node_modules || return 1
  sha="$(read_clean_deploy_sha)" || return 1
  echo "==> Deploy source clean at $sha"

  echo "==> Verifying remote WorkingDirectory for $DEPLOY_UNIT..."
  remote_dir="$(verify_path_match)" || return 1
  echo "  OK: WorkingDirectory matches ($remote_dir)"

  echo "==> Invalidating prior deployment marker (fail-closed boundary)..."
  remote_run DEPLOY_INVALIDATE_MARKER_CMD "rm -f '$remote_dir/.deployed-commit' '$remote_dir/.deployed-commit.tmp'"

  echo "==> Syncing to $(rsync_dest)..."
  rsync_out="$(rsync -a --delete -i "${RSYNC_EXCLUDES[@]}" ./ "$(rsync_dest)")"
  printf '%s\n' "$rsync_out"
  # rsync -i always itemizes the destination ROOT directory (typically ".d..t.... ./", an
  # attribute/timestamp-only line) even when nothing inside changed, so a naive "output
  # non-empty" check would restart on every single deploy. An itemize line's first column is
  # "." when only attributes changed and the file itself was not transferred; a real content
  # transfer, creation, hardlink, or deletion uses '>' / 'c' / 'h' / '*' instead. Only THOSE
  # lines mean the payload actually changed.
  if printf '%s\n' "$rsync_out" | grep -qE '^[^.]'; then payload_changed=1; fi

  # Close the TOCTOU window between the initial check and rsync reading the tree (mirrors
  # hugin/scripts/deploy-pi.sh's post-sync re-check): if source changed mid-sync, the payload no
  # longer represents the single commit we're about to stamp, so refuse to go further. The marker
  # was already invalidated above, so this leaves the box markerless rather than misrepresented.
  if ! post_sha="$(read_clean_deploy_sha)" || [ "$post_sha" != "$sha" ]; then
    echo "ERROR: deploy source changed during sync; refusing to install/restart/certify." >&2
    return 1
  fi

  echo "==> Seeding routing table (copy-if-absent; adopted tables are never overwritten -- issue #44)..."
  seed_routing_table

  echo "==> Installing dependencies on the remote (native modules must build for its own platform)..."
  remote_run DEPLOY_INSTALL_CMD "cd '$remote_dir' && npm ci --omit=dev"

  if [ "$payload_changed" = 1 ] || [ "$DEPLOY_FORCE_RESTART" = 1 ]; then
    echo "==> Preflighting ExecStart interpreter before restart (issue #30)..."
    preflight_interpreter || return 1
    echo "==> Restarting $DEPLOY_UNIT (payload changed)..."
    echo "    NOTE: the gateway also serves /mcp -- this drops live MCP transports (clients"
    echo "    reconnect on next call); in-flight async code_loop jobs survive via the durable"
    echo "    SQLite store, not the process."
    remote_run DEPLOY_RESTART_CMD "sudo systemctl restart '$DEPLOY_UNIT' && sleep 2 && systemctl is-active '$DEPLOY_UNIT'"
  else
    echo "==> Skipping restart -- rsync reported no changes and DEPLOY_FORCE_RESTART is not set."
  fi

  echo "==> Probing local health..."
  probe_health "$DEPLOY_HEALTH_LOCAL_URL" "local" 0 || return 1
  echo "==> Probing tailnet health..."
  probe_health "$DEPLOY_HEALTH_TAILNET_URL" "tailnet" || return 1
  echo "==> Probing authenticated capability endpoint..."
  probe_capability || return 1

  # Armed LAST, only once restart-if-needed + every health/capability probe above has already
  # succeeded (review finding: Persistent=true's catch-up semantics mean arming any earlier risks
  # a missed tick firing against a gateway that is still mid-restart).
  echo "==> Installing/enabling the gi#49 autonomy-tick user-scope systemd timer..."
  install_user_units "$remote_dir" || return 1

  echo "==> All checks passed -- recording accepted deployment $sha..."
  remote_run DEPLOY_WRITE_MARKER_CMD "printf '%s\n' '$sha' > '$remote_dir/.deployed-commit.tmp' && mv '$remote_dir/.deployed-commit.tmp' '$remote_dir/.deployed-commit'"
  echo "Deployed $sha to $remote_dir."
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-gateway.sh [deploy|verify|dry-run]

Modes:
  deploy    Sync + install + restart-if-needed + probe + stamp .deployed-commit (default).
  verify    Read-only: report the currently deployed commit plus a content spot-check.
  dry-run   Print the plan without syncing, restarting, or writing the marker.

Key env vars (see deploy/README.md, "Live deployment (authoritative)"):
  DEPLOY_REMOTE_HOST          ssh alias (default: m5). Never a raw IP in docs/commits.
  DEPLOY_REMOTE_DIR           Expected live WorkingDirectory (default: /home/magnus/home-server-eval)
  DEPLOY_UNIT                 systemd unit name (default: home-gateway.service)
  DEPLOY_HEALTH_LOCAL_URL     (default: unset -- best-effort/non-blocking; the gateway binds only
                              the tailnet interface, so loopback has nothing to probe by default)
  DEPLOY_HEALTH_TAILNET_URL   Required for `deploy` (no safe default -- never hardcode the IP)
  DEPLOY_CAPABILITY_URL       Authenticated capability probe URL, required for `deploy`
  DEPLOY_CAPABILITY_KEY_ENV   Name of the env var holding the bearer key (default: HOMESERVER_OWNER_KEY)
  DEPLOY_FORCE_RESTART=1      Restart even if rsync reported no changes
  DEPLOY_DRY_RUN_OFFLINE=1    dry-run only: skip even the read-only WorkingDirectory check

Routing-table seeding (issue #44), the restart interpreter preflight (issue #30), and the gi#49
autonomy-tick user-scope systemd unit render/interpreter-check/lingering-check/enable (armed LAST,
after every health/capability probe) have no operator-facing flags -- they always run as part of
`deploy`. Their remote commands are overridable for tests the same way every other remote step is
(DEPLOY_EXECSTART_PROBE_CMD, DEPLOY_INTERPRETER_CHECK_CMD, DEPLOY_UNITS_RENDER_CMD,
DEPLOY_UNITS_RELOAD_CMD, DEPLOY_LINGER_CHECK_CMD, DEPLOY_UNITS_ENABLE_CMD; see
tests/deploy-gateway.test.ts).
EOF
}

main() {
  local mode="${1:-deploy}"
  case "$mode" in
    deploy) shift || true; cmd_deploy "$@" ;;
    verify) shift || true; cmd_verify "$@" ;;
    dry-run) shift || true; cmd_dry_run "$@" ;;
    -h|--help|help) usage ;;
    *) echo "ERROR: unknown mode '$mode'" >&2; usage >&2; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
