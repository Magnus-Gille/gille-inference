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
 *   • Roots must be ABSOLUTE DIRECTORIES: a relative entry in HOMESERVER_BLIND_CONTEXT_ROOTS
 *     would resolve against whatever CWD the gateway happened to launch from (systemd
 *     WorkingDirectory, a test runner, …) — the allowlist would silently change meaning per
 *     launch context. Relative entries and non-directory targets are DROPPED by resolveRoots();
 *     if none survive, the feature behaves as disabled.
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
export const MAX_BLIND_CONTEXT_ROOTS = 128;
export const BLIND_CONTEXT_DISCOVERY_SIGNAL_TTL_MS = 5_000;
/**
 * @deprecated Discovery is live on every call; this legacy name now controls only repeated
 * content-blind operator-signal deduping for the same dropped-root observation.
 */
export const BLIND_CONTEXT_DISCOVERY_CACHE_TTL_MS = BLIND_CONTEXT_DISCOVERY_SIGNAL_TTL_MS;

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

export type BlindContextAvailabilityReason = "enabled" | "unconfigured" | "no_resolved_roots";

export type BlindContextRootDropReason = "not_absolute" | "not_found" | "not_directory" | "unreadable";

export interface BlindContextRootDropCounts {
  not_absolute: number;
  not_found: number;
  not_directory: number;
  unreadable: number;
}

export interface BlindContextAvailability {
  enabled: boolean;
  reason: BlindContextAvailabilityReason;
  resolvedRootCount: number;
}

export interface BlindContextAvailabilityInspection extends BlindContextAvailability {
  configuredRootCount: number;
  droppedRootCount: number;
  droppedRootCounts: BlindContextRootDropCounts;
  resolvedRoots: string[];
}

interface BlindContextFsOps {
  realpathSync: typeof realpathSync;
  statSync: typeof statSync;
}

export interface BlindContextOperatorSignal {
  configured_root_count: number;
  resolved_root_count: number;
  dropped_root_count: number;
  dropped_root_reasons: Partial<Record<BlindContextRootDropReason, number>>;
}

export interface BlindContextAvailabilityOptions {
  /**
   * Optional TTL for deduping repeated content-blind operator signals about the same dropped-root
   * observation. Discovery itself always re-inspects the filesystem on every call.
   */
  signalTtlMs?: number;
  /**
   * @deprecated Discovery is live on every call; retained only as a compatibility alias for
   * `signalTtlMs`.
   */
  cacheTtlMs?: number;
  fsOps?: BlindContextFsOps;
  now?: () => number;
  signal?: (signal: BlindContextOperatorSignal) => void;
}

const FILE_HEADER = (p: string): string => `===== FILE: ${p} =====`;
const FILE_FOOTER = "===== END FILE =====";
const PREAMBLE = (n: number): string =>
  `[${n} file${n === 1 ? "" : "s"} attached server-side by the caller — provided below as additional local context]`;

const DEFAULT_FS_OPS: BlindContextFsOps = {
  realpathSync,
  statSync,
};

function emptyDropCounts(): BlindContextRootDropCounts {
  return {
    not_absolute: 0,
    not_found: 0,
    not_directory: 0,
    unreadable: 0,
  };
}

function totalDroppedRoots(counts: BlindContextRootDropCounts): number {
  return counts.not_absolute + counts.not_found + counts.not_directory + counts.unreadable;
}

function countRootDrop(
  counts: BlindContextRootDropCounts,
  reason: BlindContextRootDropReason
): BlindContextRootDropCounts {
  return {
    ...counts,
    [reason]: counts[reason] + 1,
  };
}

function nonZeroDropReasons(counts: BlindContextRootDropCounts): Partial<Record<BlindContextRootDropReason, number>> {
  return Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count > 0)
  ) as Partial<Record<BlindContextRootDropReason, number>>;
}

function defaultBlindContextSignal(signal: BlindContextOperatorSignal): void {
  console.warn(
    `[blind-context] dropped unusable configured roots ${JSON.stringify(signal)}`
  );
}

interface BlindContextOperatorSignalCacheEntry {
  observedAtMs: number;
  signal: BlindContextOperatorSignal;
}

const discoverySignalCache = new Map<string, BlindContextOperatorSignalCacheEntry>();

function sameDropReasons(
  left: Partial<Record<BlindContextRootDropReason, number>>,
  right: Partial<Record<BlindContextRootDropReason, number>>
): boolean {
  return (
    (left.not_absolute ?? 0) === (right.not_absolute ?? 0)
    && (left.not_found ?? 0) === (right.not_found ?? 0)
    && (left.not_directory ?? 0) === (right.not_directory ?? 0)
    && (left.unreadable ?? 0) === (right.unreadable ?? 0)
  );
}

function sameOperatorSignal(left: BlindContextOperatorSignal, right: BlindContextOperatorSignal): boolean {
  return (
    left.configured_root_count === right.configured_root_count
    && left.resolved_root_count === right.resolved_root_count
    && left.dropped_root_count === right.dropped_root_count
    && sameDropReasons(left.dropped_root_reasons, right.dropped_root_reasons)
  );
}

function shouldEmitOperatorSignal(
  cacheKey: string,
  signal: BlindContextOperatorSignal,
  nowMs: number,
  signalTtlMs: number
): boolean {
  const cached = discoverySignalCache.get(cacheKey);
  if (!cached) {
    discoverySignalCache.set(cacheKey, { observedAtMs: nowMs, signal });
    return true;
  }
  if (!sameOperatorSignal(cached.signal, signal)) {
    discoverySignalCache.set(cacheKey, { observedAtMs: nowMs, signal });
    return true;
  }
  if (nowMs - cached.observedAtMs >= signalTtlMs) {
    discoverySignalCache.set(cacheKey, { observedAtMs: nowMs, signal });
    return true;
  }
  return false;
}

/**
 * Resolve every configured root to one canonical (symlink-free) DIRECTORY path. A root that fails
 * to resolve (misconfigured / deleted / permission-denied), resolves to a non-directory, or is
 * RELATIVE (its meaning would depend on the gateway's launch CWD; see the security model above)
 * is silently dropped rather than crashing every request. Canonical duplicates are collapsed so a
 * raw duplicate or symlink alias never inflates the allowlist or the discovery count. The
 * operator notices only if EVERY configured root is bad, at which point the feature behaves
 * identically to "disabled" (fail-safe, not fail-open).
 */
function resolveRoots(
  roots: readonly string[],
  fsOps: BlindContextFsOps
): { resolvedRoots: string[]; droppedRootCounts: BlindContextRootDropCounts } {
  const resolved = new Set<string>();
  let droppedRootCounts = emptyDropCounts();
  for (const root of roots) {
    if (!isAbsolute(root)) {
      droppedRootCounts = countRootDrop(droppedRootCounts, "not_absolute");
      continue; // never let a CWD-dependent entry into the allowlist
    }
    try {
      const canonical = fsOps.realpathSync(root);
      if (!fsOps.statSync(canonical).isDirectory()) {
        droppedRootCounts = countRootDrop(droppedRootCounts, "not_directory");
        continue;
      }
      resolved.add(canonical);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") {
        droppedRootCounts = countRootDrop(droppedRootCounts, "not_found");
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        droppedRootCounts = countRootDrop(droppedRootCounts, "unreadable");
        continue;
      }
      droppedRootCounts = countRootDrop(droppedRootCounts, "unreadable");
    }
  }
  return { resolvedRoots: [...resolved], droppedRootCounts };
}

/**
 * Live, content-blind availability summary for discovery surfaces: request-facing callers get the
 * current usable state on every call without exposing any root locators or mutating the configured
 * root list. Any optional TTL applies only to duplicate operator-signal suppression, never to the
 * returned availability snapshot.
 */
export function describeBlindContextAvailability(
  roots: readonly string[],
  options: BlindContextAvailabilityOptions = {}
): BlindContextAvailability {
  const inspection = inspectBlindContextAvailability(roots, options);
  if (inspection.droppedRootCount > 0) {
    const operatorSignal = {
      configured_root_count: inspection.configuredRootCount,
      resolved_root_count: inspection.resolvedRootCount,
      dropped_root_count: inspection.droppedRootCount,
      dropped_root_reasons: nonZeroDropReasons(inspection.droppedRootCounts),
    };
    const nowMs = (options.now ?? Date.now)();
    const signalTtlMs = options.signalTtlMs ?? options.cacheTtlMs ?? BLIND_CONTEXT_DISCOVERY_SIGNAL_TTL_MS;
    if (shouldEmitOperatorSignal(roots.join("\u0000"), operatorSignal, nowMs, signalTtlMs)) {
      (options.signal ?? defaultBlindContextSignal)(operatorSignal);
    }
  }
  return {
    enabled: inspection.enabled,
    reason: inspection.reason,
    resolvedRootCount: inspection.resolvedRootCount,
  };
}

/**
 * The richer availability form for callers that need both the content-blind discovery summary and
 * the resolved allowlist roots without exposing those roots on discovery surfaces.
 */
export function inspectBlindContextAvailability(
  roots: readonly string[],
  options: BlindContextAvailabilityOptions = {}
): BlindContextAvailabilityInspection {
  const configuredRootCount = roots.length;
  const fsOps = options.fsOps ?? DEFAULT_FS_OPS;
  if (roots.length === 0) {
    return {
      enabled: false,
      reason: "unconfigured",
      configuredRootCount,
      resolvedRootCount: 0,
      droppedRootCount: 0,
      droppedRootCounts: emptyDropCounts(),
      resolvedRoots: [],
    };
  }
  const { resolvedRoots, droppedRootCounts } = resolveRoots(roots, fsOps);
  const droppedRootCount = totalDroppedRoots(droppedRootCounts);
  if (resolvedRoots.length === 0) {
    return {
      enabled: false,
      reason: "no_resolved_roots",
      configuredRootCount,
      resolvedRootCount: 0,
      droppedRootCount,
      droppedRootCounts,
      resolvedRoots,
    };
  }
  return {
    enabled: true,
    reason: "enabled",
    configuredRootCount,
    resolvedRootCount: resolvedRoots.length,
    droppedRootCount,
    droppedRootCounts,
    resolvedRoots,
  };
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

  const availability = inspectBlindContextAvailability(cfg.roots);
  if (!availability.enabled) {
    return {
      ok: false,
      error: {
        code: "disabled",
        path: null,
        message:
          availability.reason === "unconfigured"
            ? "File attachments are disabled on this server (HOMESERVER_BLIND_CONTEXT_ROOTS is not configured)."
            : "File attachments are disabled — none of the configured HOMESERVER_BLIND_CONTEXT_ROOTS resolve to a real directory.",
      },
    };
  }
  const roots = availability.resolvedRoots;

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
