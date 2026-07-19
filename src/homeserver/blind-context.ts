import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Blind-context delegation (issue #128): the MCP `ask` tool accepts an OWNER-ONLY optional
 * `files?: string[]` of absolute paths on the box. This module expands them server-side into
 * clearly-delimited text blocks that get prepended to the caller's message — so a cloud caller
 * (Claude Code) can orchestrate over LOCAL data it never ingests: only the box reads the file,
 * the local model sees the content, and the frontier caller sees only the model's answer text.
 *
 * Pure by construction: every knob (allowlist roots, byte caps) is passed in explicitly by the
 * caller (mcp.ts, sourced from HomeserverConfig) rather than read from env/config globals here —
 * so this module is trivially unit-testable against real temp dirs (fs.mkdtempSync) with no
 * process-global state to reset between tests, and callers can inject whatever config a test
 * scenario needs without touching process.env.
 *
 * SECURITY MODEL (this is the trust anchor for a security-sensitive feature — read carefully):
 *
 *   • DEFAULT-DISABLED: `roots` empty (the HOMESERVER_BLIND_CONTEXT_ROOTS default) means ANY
 *     non-empty `files` request errors with an actionable message. There is no way for an unset
 *     env var to silently widen into "everything is allowed" — the fail-safe direction is closed.
 *
 *   • TIER ENFORCEMENT LIVES IN THE CALLER (mcp.ts), NOT HERE. This module has no notion of a
 *     principal or tier and never should — it is invoked ONLY after mcp.ts has already verified
 *     the caller is owner-tier (the earliest point in the request that knows both the resolved
 *     tier and the tool-specific `files` argument). Keeping tier logic OUT of a pure path-safety
 *     module keeps this module's contract simple: "given these roots and these paths, either
 *     expand safely or say exactly why not."
 *
 *   • realpath-BEFORE-prefix-check: every input path (and every configured root) is resolved to
 *     its canonical filesystem path via `realpathSync` — which fully resolves symlinks AND
 *     collapses `..` segments — before the containment check runs. This closes both the classic
 *     `/allowed/../../etc/passwd` traversal AND a symlink planted inside an allowed root that
 *     points outside it; a string-prefix check on the UNRESOLVED path would miss both (a `..` in
 *     the literal string doesn't have to survive to the resolved path, and a symlink's target is
 *     invisible to a prefix check on the link's own location).
 *
 *   • Root-prefix containment guards the "/allowed-evil" footgun: containment requires the
 *     resolved path to fall UNDER `root + "/"` (or equal `root` itself), never merely start with
 *     the root string — otherwise an allowed root of `/data/allowed` would wrongly admit a
 *     sibling directory named `/data/allowed-2` that was never intended to be exposed.
 *
 *   • Roots must be ABSOLUTE: a relative entry in HOMESERVER_BLIND_CONTEXT_ROOTS would resolve
 *     against whatever CWD the gateway happened to launch from (systemd WorkingDirectory, a test
 *     runner, …) — the allowlist would silently change meaning per launch context. Relative
 *     entries are DROPPED by resolveRoots(); if none survive, the feature behaves as disabled.
 *
 *   • TOCTOU hardening (realpath → open race): after the containment check we do NOT read by
 *     path. The canonical path is opened with O_NOFOLLOW|O_NONBLOCK, the OPEN DESCRIPTOR is
 *     fstat-verified (regular file + size caps), and the read goes through that same descriptor —
 *     so a final path component swapped to a symlink between realpath and open is rejected
 *     (ELOOP), a path swapped to a FIFO/device cannot block or side-effect the open (O_NONBLOCK),
 *     and stat/read always describe the same inode. Post-read, the ACTUAL byte count is
 *     re-checked against both caps, so a file that grows between fstat and read (live log files)
 *     cannot smuggle past the size caps. REMAINING accepted gap: an INTERMEDIATE directory
 *     component swapped to a symlink mid-request is not detectable with portable Node APIs (no
 *     openat2/RESOLVE_BENEATH) — exploiting it requires local write access inside an allowed
 *     root, and the feature is owner-tier-only.
 *
 *   • File-count cap (MAX_FILES_PER_REQUEST): the byte caps count RAW FILE CONTENT only — the
 *     per-file preamble/header/footer text (which embeds the caller-supplied path, up to ~4 KiB
 *     each) is not byte-metered. Without a count cap, many tiny/empty files could inflate the
 *     injected text far beyond maxTotalBytes' intent. The count cap bounds that overhead.
 *
 *   • PROMPT INJECTION via attached content is an ACCEPTED, DOCUMENTED gap: file content is
 *     injected VERBATIM — a file that itself contains the `===== FILE:` / `===== END FILE =====`
 *     delimiters (or adversarial instructions) can make the model mis-read where a file ends. No
 *     in-band escaping is robust against a model, so none is attempted. Treat every attached file
 *     as UNTRUSTED MODEL INPUT, never as trusted instructions; the deterministic guards here
 *     protect the FILESYSTEM boundary (what may be read), not the model's interpretation of it.
 *
 *   • Binary rejection is a null-byte heuristic (NOT full UTF-8 validation): real UTF-8 text
 *     essentially never contains a NUL byte, while every binary format sampled in practice
 *     (images, archives, compiled objects, databases) does within the first few bytes. This is a
 *     deliberate, documented simplification — good enough to keep a stray binary out of the
 *     model's context window without pulling in a real charset-detection dependency. It will NOT
 *     catch every malformed-UTF-8 byte sequence; that is an accepted gap, not an oversight.
 */

/**
 * Hard cap on the number of files in one request. Bounds the un-byte-metered delimiter/header
 * overhead (see the security model above) and keeps a single `ask` from turning into a bulk
 * filesystem export. 64 × the 256 KiB default per-file cap comfortably exceeds the 1 MiB default
 * total cap, so legitimate use never hits this first.
 */
export const MAX_FILES_PER_REQUEST = 64;

/** Explicit, DI-friendly config — never read from env/global config inside this module. */
export interface BlindContextConfig {
  /** Allowlist root directories (raw, as configured). Empty array = feature DISABLED. */
  roots: readonly string[];
  /** Per-file byte cap (checked via fstat before the read, re-checked on the actual bytes read). */
  maxFileBytes: number;
  /** Cumulative byte cap across every file in one request. */
  maxTotalBytes: number;
}

export type BlindContextErrorCode =
  | "disabled"
  | "not_absolute"
  | "not_found"
  | "outside_roots"
  | "not_a_file"
  | "unreadable"
  | "binary"
  | "file_too_large"
  | "total_too_large"
  | "too_many_files";

export interface BlindContextError {
  code: BlindContextErrorCode;
  /** The offending input path, verbatim as supplied by the caller. null for the request-level codes ("disabled", "too_many_files"). */
  path: string | null;
  /** Human-readable, actionable message — safe to surface directly to the caller. */
  message: string;
}

export interface BlindContextExpansion {
  /**
   * Ready to prepend to the outgoing user message content (preamble + delimited file blocks,
   * joined). Empty string when `filePaths` was empty (a deliberate no-op, not an error).
   */
  text: string;
  fileCount: number;
  /** Sum of the raw file byte sizes actually read (excludes the header/footer/preamble text). */
  totalBytes: number;
}

export type BlindContextResult = ({ ok: true } & BlindContextExpansion) | { ok: false; error: BlindContextError };

const FILE_HEADER = (p: string): string => `===== FILE: ${p} =====`;
const FILE_FOOTER = "===== END FILE =====";
const PREAMBLE = (n: number): string =>
  `[${n} file${n === 1 ? "" : "s"} attached server-side by the caller — provided below as additional local context]`;

/**
 * Resolve every configured root to its canonical (symlink-free) path. A root that fails to
 * resolve (misconfigured / deleted / permission-denied) — or is RELATIVE (its meaning would
 * depend on the gateway's launch CWD; see the security model above) — is silently dropped rather
 * than crashing every request — the operator notices only if EVERY configured root is bad, at
 * which point the feature behaves identically to "disabled" (fail-safe, not fail-open).
 */
function resolveRoots(roots: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) continue; // never let a CWD-dependent entry into the allowlist
    try {
      resolved.push(realpathSync(root));
    } catch {
      // Skip an unusable root — see doc comment above.
    }
  }
  return resolved;
}

/**
 * True iff `resolvedPath` is `root` itself or lies strictly under it. Deliberately NOT a bare
 * `startsWith(root)` — that would also admit an unrelated sibling like `${root}-evil`.
 */
function isUnderRoot(resolvedPath: string, root: string): boolean {
  if (resolvedPath === root) return true;
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return resolvedPath.startsWith(withSep);
}

/**
 * Expand `filePaths` into one delimited context block per file, enforcing the allowlist +
 * traversal + size + binary guards documented above. Fails CLOSED and FAST: the first violation
 * encountered (in input order) short-circuits the whole request with a typed, actionable error —
 * there is no partial-success mode, so a caller never has to reason about "which files made it
 * through."
 *
 * `filePaths` empty is a deliberate no-op (`{ ok: true, text: "", fileCount: 0, totalBytes: 0 }`)
 * regardless of `cfg.roots` — the caller decides whether to invoke this at all; an empty `files`
 * array is not a request for the feature.
 */
export function expandBlindContext(filePaths: readonly string[], cfg: BlindContextConfig): BlindContextResult {
  if (filePaths.length === 0) {
    return { ok: true, text: "", fileCount: 0, totalBytes: 0 };
  }

  if (cfg.roots.length === 0) {
    return {
      ok: false,
      error: {
        code: "disabled",
        path: null,
        message:
          "File attachments are disabled on this server (HOMESERVER_BLIND_CONTEXT_ROOTS is not configured).",
      },
    };
  }

  const roots = resolveRoots(cfg.roots);
  if (roots.length === 0) {
    return {
      ok: false,
      error: {
        code: "disabled",
        path: null,
        message:
          "File attachments are disabled — none of the configured HOMESERVER_BLIND_CONTEXT_ROOTS resolve to a real directory.",
      },
    };
  }

  // Count cap — bounds the un-byte-metered delimiter/header overhead (see MAX_FILES_PER_REQUEST).
  if (filePaths.length > MAX_FILES_PER_REQUEST) {
    return {
      ok: false,
      error: {
        code: "too_many_files",
        path: null,
        message: `${filePaths.length} files supplied — at most ${MAX_FILES_PER_REQUEST} files may be attached per request.`,
      },
    };
  }

  const blocks: string[] = [];
  let totalBytes = 0;

  for (const rawPath of filePaths) {
    if (!isAbsolute(rawPath)) {
      return { ok: false, error: { code: "not_absolute", path: rawPath, message: `'${rawPath}' is not an absolute path.` } };
    }

    let resolved: string;
    try {
      resolved = realpathSync(rawPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EACCES" || code === "EPERM") {
        return {
          ok: false,
          error: { code: "unreadable", path: rawPath, message: `'${rawPath}' is not readable (permission denied).` },
        };
      }
      return { ok: false, error: { code: "not_found", path: rawPath, message: `'${rawPath}' does not exist.` } };
    }

    if (!roots.some((root) => isUnderRoot(resolved, root))) {
      return {
        ok: false,
        error: {
          code: "outside_roots",
          path: rawPath,
          message: `'${rawPath}' resolves outside the allowed HOMESERVER_BLIND_CONTEXT_ROOTS.`,
        },
      };
    }

    // Cheap pre-check on the path (best-effort UX): reject non-files WITHOUT opening them, so a
    // device/FIFO sitting under an allowed root is normally never even opened. NOT the security
    // check — the authoritative verification is the fstat on the open descriptor below.
    let pathStat: ReturnType<typeof statSync>;
    try {
      pathStat = statSync(resolved);
    } catch {
      return { ok: false, error: { code: "unreadable", path: rawPath, message: `'${rawPath}' could not be read.` } };
    }
    if (!pathStat.isFile()) {
      return { ok: false, error: { code: "not_a_file", path: rawPath, message: `'${rawPath}' is not a regular file.` } };
    }

    // TOCTOU hardening (see the security model above): open the CANONICAL path with
    // O_NOFOLLOW (a final component swapped to a symlink after realpath → ELOOP → rejected) and
    // O_NONBLOCK (a path swapped to a FIFO cannot block the open; harmless for regular files),
    // then verify + size-check + read through the SAME descriptor so every check describes the
    // one inode that is actually read.
    let fd: number;
    try {
      fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return { ok: false, error: { code: "unreadable", path: rawPath, message: `'${rawPath}' could not be read.` } };
    }

    let buf: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        return { ok: false, error: { code: "not_a_file", path: rawPath, message: `'${rawPath}' is not a regular file.` } };
      }
      if (stat.size > cfg.maxFileBytes) {
        return {
          ok: false,
          error: {
            code: "file_too_large",
            path: rawPath,
            message: `'${rawPath}' is ${stat.size} bytes, over the ${cfg.maxFileBytes}-byte per-file cap.`,
          },
        };
      }
      if (totalBytes + stat.size > cfg.maxTotalBytes) {
        return {
          ok: false,
          error: {
            code: "total_too_large",
            path: rawPath,
            message: `Attaching '${rawPath}' would exceed the ${cfg.maxTotalBytes}-byte total cap across all attached files.`,
          },
        };
      }

      try {
        buf = readFileSync(fd);
      } catch {
        return { ok: false, error: { code: "unreadable", path: rawPath, message: `'${rawPath}' could not be read.` } };
      }
    } finally {
      closeSync(fd);
    }

    // Post-read cap re-check on the ACTUAL byte count: a file that grew between fstat and read
    // (a live log file, or a deliberate race) must not smuggle past the size caps.
    if (buf.length > cfg.maxFileBytes) {
      return {
        ok: false,
        error: {
          code: "file_too_large",
          path: rawPath,
          message: `'${rawPath}' is ${buf.length} bytes, over the ${cfg.maxFileBytes}-byte per-file cap.`,
        },
      };
    }
    if (totalBytes + buf.length > cfg.maxTotalBytes) {
      return {
        ok: false,
        error: {
          code: "total_too_large",
          path: rawPath,
          message: `Attaching '${rawPath}' would exceed the ${cfg.maxTotalBytes}-byte total cap across all attached files.`,
        },
      };
    }

    // Binary heuristic — see the doc comment above for the rationale/limits.
    if (buf.includes(0)) {
      return {
        ok: false,
        error: { code: "binary", path: rawPath, message: `'${rawPath}' looks binary (contains a NUL byte) and was rejected.` },
      };
    }

    totalBytes += buf.length;
    blocks.push(`${FILE_HEADER(rawPath)}\n${buf.toString("utf-8")}\n${FILE_FOOTER}`);
  }

  return {
    ok: true,
    text: `${PREAMBLE(filePaths.length)}\n\n${blocks.join("\n\n")}`,
    fileCount: filePaths.length,
    totalBytes,
  };
}
