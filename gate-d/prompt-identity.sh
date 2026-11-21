# Sourced by gate-d/run.sh and gate-d/sweep.sh. Resolves GATE_D_PI_APPEND_SYSTEM to one immutable
# snapshot of a committed prompt variant (INFER-519).
#
# The variant must be a bare file name of a regular file committed at HEAD under gate-d/prompts/,
# and the working-tree copy must be identical to HEAD (no symlinks, no untracked or edited files).
# The text is read once from the HEAD blob; the same bytes are hashed and handed to pi, so a later
# edit of the file cannot change what a run received or make its digest stale.
#
# Sets PROMPT_VARIANT ("none" when unset), PROMPT_SHA ("" when unset) and PROMPT_TEXT.
# Returns 3 with a message on stderr when the variant cannot be resolved.
resolve_prompt_variant() {
  local root="$1" name="${GATE_D_PI_APPEND_SYSTEM:-}" rel entry digest
  PROMPT_VARIANT="none"; PROMPT_SHA=""; PROMPT_TEXT=""
  [ -n "$name" ] || return 0
  case "$name" in
    */*|.*) echo "error: GATE_D_PI_APPEND_SYSTEM must be a bare file name under gate-d/prompts/" >&2; return 3 ;;
  esac
  rel="gate-d/prompts/$name"
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "error: prompt variants require a git checkout of this repository" >&2; return 3; }
  entry="$(git -C "$root" ls-tree HEAD -- "$rel" 2>/dev/null | cut -f1 | cut -d' ' -f1,2)"
  [ "$entry" = "100644 blob" ] \
    || { echo "error: no such prompt variant committed as a regular file at HEAD: $rel" >&2; return 3; }
  if [ -L "$root/$rel" ] || ! git -C "$root" diff --quiet HEAD -- "$rel" 2>/dev/null; then
    echo "error: $rel differs from HEAD in the working tree; commit or restore it first" >&2; return 3
  fi
  PROMPT_TEXT="$(git -C "$root" cat-file blob "HEAD:$rel")" \
    || { echo "error: could not read $rel from HEAD" >&2; return 3; }
  [ -n "$PROMPT_TEXT" ] || { echo "error: prompt variant $rel is empty" >&2; return 3; }
  digest="$(printf '%s' "$PROMPT_TEXT" | python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')" \
    || return 3
  PROMPT_VARIANT="${name%.md}"
  PROMPT_SHA="sha256:$digest"
  if [ -n "${GATE_D_EXPECT_PROMPT_SHA:-}" ] && [ "$GATE_D_EXPECT_PROMPT_SHA" != "$PROMPT_SHA" ]; then
    echo "error: prompt variant $rel is $PROMPT_SHA, but this sweep started with $GATE_D_EXPECT_PROMPT_SHA" >&2
    return 3
  fi
  return 0
}
