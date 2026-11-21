# Sourced by gate-d/run.sh and gate-d/sweep.sh. Resolves GATE_D_PI_APPEND_SYSTEM to one immutable,
# committed prompt variant (INFER-519).
#
# The variant must be a bare file name of a regular file committed at HEAD under gate-d/prompts/,
# and its working-tree copy must be identical to that commit (no symlinks, untracked or edited
# files). HEAD is resolved once; the blob id comes from that commit's validated tree entry, and
# the digest is computed over the exact blob bytes. Inherited Git overrides are ignored so the
# lookup can only ever read this checkout.
#
# resolve_prompt_variant <repo-root>
#   Sets PROMPT_VARIANT ("none" when unset), PROMPT_SHA ("" when unset) and PROMPT_BLOB.
# snapshot_prompt_variant <repo-root> <private-dir>
#   Writes the blob to a private file, verifies its digest, and sets PROMPT_FILE (absolute path).
# Both return 3 with a message on stderr on any failure.

# Runner-owned Git: no inherited repository/index selectors, no environment- or user-supplied
# configuration (GIT_CONFIG_*, system and global config files), no init templates, no hooks, and
# no per-user attributes or excludes. Only the checkout's own .git/config still applies.
gd_git() {
  ( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
          GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_CEILING_DIRECTORIES \
          GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    git -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null \
        "$@" )
}

gd_sha256_stdin() {
  python3 -c 'import hashlib,sys;print("sha256:"+hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
}

# Reads a prompt blob on stdin, requires exactly <expected-size> bytes of strict UTF-8 without a
# byte-order mark (pi decodes the file as UTF-8 and strips a BOM, so anything else would make the
# raw-byte digest describe different text than pi uses), and prints its sha256.
gd_prompt_digest() {
  python3 -c '
import hashlib, sys
data = sys.stdin.buffer.read()
if len(data) != int(sys.argv[1]): sys.exit("error: prompt blob read was incomplete")
if data.startswith(b"\xef\xbb\xbf"): sys.exit("error: prompt variant must not start with a UTF-8 byte-order mark")
try: data.decode("utf-8", errors="strict")
except UnicodeDecodeError: sys.exit("error: prompt variant must be valid UTF-8")
print("sha256:" + hashlib.sha256(data).hexdigest())' "$1"
}

resolve_prompt_variant() {
  local root="$1" name="${GATE_D_PI_APPEND_SYSTEM:-}" rel top commit entry mode type blob size
  PROMPT_VARIANT="none"; PROMPT_SHA=""; PROMPT_BLOB=""
  [ -n "$name" ] || return 0
  case "$name" in
    */*|.*) echo "error: GATE_D_PI_APPEND_SYSTEM must be a bare file name under gate-d/prompts/" >&2; return 3 ;;
  esac
  rel="gate-d/prompts/$name"
  top="$(gd_git -C "$root" rev-parse --show-toplevel 2>/dev/null)" \
    || { echo "error: prompt variants require a git checkout of this repository" >&2; return 3; }
  [ "$(cd "$top" && pwd -P)" = "$(cd "$root" && pwd -P)" ] \
    || { echo "error: $root is not the top level of its git checkout ($top)" >&2; return 3; }
  commit="$(gd_git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}')" \
    || { echo "error: could not resolve HEAD" >&2; return 3; }
  entry="$(gd_git -C "$root" ls-tree "$commit" -- "$rel" 2>/dev/null)"
  mode="$(printf '%s' "$entry" | cut -f1 | cut -d' ' -f1)"
  type="$(printf '%s' "$entry" | cut -f1 | cut -d' ' -f2)"
  blob="$(printf '%s' "$entry" | cut -f1 | cut -d' ' -f3)"
  [ "$mode $type" = "100644 blob" ] && [ -n "$blob" ] \
    || { echo "error: no such prompt variant committed as a regular file at HEAD: $rel" >&2; return 3; }
  if [ -L "$root/$rel" ] || ! gd_git -C "$root" diff --quiet "$commit" -- "$rel" 2>/dev/null; then
    echo "error: $rel differs from HEAD in the working tree; commit or restore it first" >&2; return 3
  fi
  size="$(gd_git -C "$root" cat-file -s "$blob" 2>/dev/null)"
  [ -n "$size" ] && [ "$size" -gt 0 ] 2>/dev/null \
    || { echo "error: prompt variant $rel is empty or unreadable" >&2; return 3; }
  # pipefail inside the substitution: a failed blob read must fail here, not hash empty input.
  PROMPT_SHA="$(set -o pipefail; gd_git -C "$root" cat-file blob "$blob" | gd_prompt_digest "$size")" \
    || { echo "error: could not validate $rel at HEAD" >&2; return 3; }
  PROMPT_VARIANT="${name%.md}"
  PROMPT_BLOB="$blob"
  if [ -n "${GATE_D_EXPECT_PROMPT_SHA:-}" ] && [ "$GATE_D_EXPECT_PROMPT_SHA" != "$PROMPT_SHA" ]; then
    echo "error: prompt variant $rel is $PROMPT_SHA, but this sweep started with $GATE_D_EXPECT_PROMPT_SHA" >&2
    return 3
  fi
  return 0
}

# Limitation: the arm runs as the same OS user as the runner, so it could change the snapshot and
# restore it between the two checks. The row's digest attests to the committed blob the runner
# resolved and handed over, not to a kernel-enforced read-only boundary.
snapshot_prompt_variant() {
  local root="$1" dir="$2"
  PROMPT_FILE=""
  [ -n "$PROMPT_BLOB" ] || return 0
  PROMPT_FILE="$dir/prompt.md"
  ( umask 077; gd_git -C "$root" cat-file blob "$PROMPT_BLOB" >"$PROMPT_FILE" ) \
    || { echo "error: could not snapshot the prompt variant" >&2; return 3; }
  chmod 0400 "$PROMPT_FILE" 2>/dev/null || true
  verify_prompt_snapshot || return 3
}

verify_prompt_snapshot() {
  [ -n "${PROMPT_FILE:-}" ] || return 0
  if [ -L "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ] || [ "$(gd_sha256_stdin <"$PROMPT_FILE")" != "$PROMPT_SHA" ]; then
    echo "error: the prompt snapshot $PROMPT_FILE no longer matches $PROMPT_SHA" >&2
    return 3
  fi
}
