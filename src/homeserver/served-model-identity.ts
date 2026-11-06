/**
 * Canonical served-model identity for the direct OpenAI-compatible relay (INFER-343).
 *
 * The roster ID a caller requests (the `id` advertised by GET /v1/models, i.e. the llama-swap
 * model key) is the canonical public identity. The `model` field the backend puts in a chat
 * response is whatever llama-server reports: its `--alias` when one is set, otherwise the model
 * file path/name. Those are different namespaces, so a roster entry served without an explicit
 * `--alias` produced `model` values that did not equal the requested ID.
 *
 * Contract (see docs/gateway-api-contract.md, "Served model identity"):
 *   - `model` equals the requested roster ID            -> verified, forwarded unchanged.
 *   - `model` is in the operator-configured alias set
 *     for exactly that roster ID                        -> verified, rewritten to the roster ID.
 *   - `model` is absent / null (provenance unavailable) -> forwarded unchanged. We never inject
 *     a model we did not observe.
 *   - anything else (other string, empty, non-string)   -> mismatch: fail closed, named error,
 *     billed zero. A requested ID is never blindly echoed and arbitrary returned IDs are never
 *     whitelisted: only an explicit roster->served pair from configuration can bridge the gap.
 *
 * Diagnostics deliberately never include the served identity (it may be a private file path),
 * the backend command, credentials, or request/response content.
 */
import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** roster ID -> set of served identities explicitly declared as that same model. */
export type ServedModelAliasMap = ReadonlyMap<string, ReadonlySet<string>>;

export const SERVED_MODEL_ALIASES_ENV = "HOMESERVER_SERVED_MODEL_ALIASES";
export const SERVED_MODEL_IDENTITY_MODE_ENV = "HOMESERVER_SERVED_MODEL_IDENTITY";

/** shadow (default): verify + rewrite declared aliases, pass mismatches through and count them. */
export type ServedModelIdentityMode = "off" | "shadow" | "enforce";

/** Unset/empty -> shadow. Any other unknown value throws WITHOUT echoing it. */
export function parseServedModelIdentityMode(raw: string | undefined): ServedModelIdentityMode {
  if (raw === undefined || raw === "") return "shadow";
  if (raw === "off" || raw === "shadow" || raw === "enforce") return raw;
  throw new Error(`${SERVED_MODEL_IDENTITY_MODE_ENV} must be one of: off, shadow, enforce`);
}
const MAX_IDENTITY_CHARS = 512;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDENTITY_CHARS && !CONTROL.test(value) && value === value.trim();
}

/**
 * Parse `roster=served` entries (one per comma-separated env item; repeat a roster ID to declare
 * several served identities). Throws on malformed input WITHOUT echoing the offending value, so
 * a startup error cannot leak a private path into logs.
 */
export function parseServedModelAliases(entries: readonly string[]): ServedModelAliasMap {
  const map = new Map<string, Set<string>>();
  entries.forEach((entry, index) => {
    const eq = entry.indexOf("=");
    const roster = eq === -1 ? "" : entry.slice(0, eq).trim();
    const served = eq === -1 ? "" : entry.slice(eq + 1).trim();
    if (!validIdentity(roster) || !validIdentity(served) || roster === served) {
      throw new Error(`${SERVED_MODEL_ALIASES_ENV} entry ${index + 1} is not a valid 'roster-id=served-identity' pair`);
    }
    let set = map.get(roster);
    if (set === undefined) map.set(roster, (set = new Set()));
    set.add(served);
  });
  return map;
}

export type ServedIdentityVerdict = "canonical" | "aliased" | "absent" | "mismatch";

/**
 * The roster ID an identity check runs against: the already-canonicalized request model
 * (`canonicalizeModelTrusted`). That function returns the requested string unchanged only when it
 * is an exact allow-list/catalogue (roster) ID, otherwise the "unknown" sentinel (or null/"none"
 * for non-inference routes), so canonical is always either the requested roster ID or a sentinel.
 * A sentinel means the request did not name a roster ID we can vouch for, so there is no identity
 * to verify and the check is skipped (null). The same value keys the alias lookup and labels the
 * shadow metric.
 */
export function rosterIdentityOf(canonical: string | null | undefined): string | null {
  if (canonical === null || canonical === undefined) return null;
  if (canonical === "" || canonical === "unknown" || canonical === "none") return null;
  return canonical;
}

/**
 * What a response's `model` is checked against.
 *  - `check`: a concrete identity (the resolved roster ID, or in enforce the requested string).
 *  - `unverifiable` (enforce only): nothing usable was requested and no roster ID resolved, so no
 *    reported `model` can be verified; any present value fails closed, absent/null passes.
 *  - `skip`: no check (off; shadow with an unresolved roster ID so it adds no false positives).
 */
export type IdentitySubject =
  | { kind: "check"; id: string }
  | { kind: "unverifiable" }
  | { kind: "skip" };

/** Accepts a plain string / null for convenience (string -> check, null -> skip). */
export function asIdentitySubject(subject: IdentitySubject | string | null): IdentitySubject {
  if (subject === null) return { kind: "skip" };
  return typeof subject === "string" ? { kind: "check", id: subject } : subject;
}

/**
 * The subject an enforce/shadow check is made against.
 *  - A resolved roster ID is always the subject (all checking modes).
 *  - Unresolved (cold/stale catalogue, unrecognised spelling): `enforce` NEVER forwards an
 *    unverified identity, so it checks the requested string exactly as sent (exact match, or an alias
 *    declared for that exact string; anything else is a mismatch). With no usable requested string it
 *    is `unverifiable`. `shadow` skips; `off` never checks.
 */
export function identitySubject(
  mode: ServedModelIdentityMode,
  canonical: string | null | undefined,
  requested: string | null | undefined,
): IdentitySubject {
  if (mode === "off") return { kind: "skip" };
  const roster = rosterIdentityOf(canonical);
  if (roster !== null) return { kind: "check", id: roster };
  if (mode === "enforce") {
    return typeof requested === "string" && requested !== ""
      ? { kind: "check", id: requested }
      : { kind: "unverifiable" };
  }
  return { kind: "skip" };
}

/** Judge one reported `model` value against the requested roster ID. */
export function judgeServedIdentity(
  requested: string,
  reported: unknown,
  aliases: ServedModelAliasMap,
): ServedIdentityVerdict {
  if (reported === undefined || reported === null) return "absent";
  if (typeof reported !== "string") return "mismatch";
  if (reported === requested) return "canonical";
  return aliases.get(requested)?.has(reported) === true ? "aliased" : "mismatch";
}

function judgeSubject(
  subject: { kind: "check"; id: string } | { kind: "unverifiable" },
  reported: unknown,
  aliases: ServedModelAliasMap,
): ServedIdentityVerdict {
  if (subject.kind === "check") return judgeServedIdentity(subject.id, reported, aliases);
  return reported === undefined || reported === null ? "absent" : "mismatch";
}

export type CompletionIdentityResult =
  | { kind: "unchanged"; text: string }
  | { kind: "rewritten"; text: string }
  | { kind: "mismatch" }
  /** Shadow mode only: a mismatch that is passed through unchanged (caller counts it). */
  | { kind: "mismatch_shadow"; text: string };

/**
 * Reconcile a buffered (non-streaming) chat completion body. A body that is not a JSON object
 * carries no identity claim and is left to the caller's existing handling.
 */
export function reconcileCompletionIdentity(
  text: string,
  requested: IdentitySubject | string | null,
  aliases: ServedModelAliasMap,
  mode: ServedModelIdentityMode,
): CompletionIdentityResult {
  const subject = asIdentitySubject(requested);
  if (subject.kind === "skip" || mode === "off") return { kind: "unchanged", text };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unchanged", text };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return { kind: "unchanged", text };
  const obj = json as Record<string, unknown>;
  const verdict = judgeSubject(subject, obj["model"], aliases);
  if (verdict === "mismatch") {
    return mode === "shadow" ? { kind: "mismatch_shadow", text } : { kind: "mismatch" };
  }
  if (verdict !== "aliased" || subject.kind !== "check") return { kind: "unchanged", text };
  return { kind: "rewritten", text: JSON.stringify({ ...obj, model: subject.id }) };
}

/** Raised by {@link ServedIdentityGuard}; carries no identity text by design. */
export class ServedIdentityMismatchError extends Error {
  /** `mismatch`: a verified-wrong identity; `unverifiable`: a frame that should carry JSON did not parse; `overflow`: pending event too large. */
  constructor(readonly reason: "mismatch" | "unverifiable" | "overflow" = "mismatch") {
    super("served model identity mismatch");
    this.name = "ServedIdentityMismatchError";
  }
}

/** Upper bound on one pending (not yet terminated) SSE event. */
export const MAX_PENDING_SSE_EVENT_CHARS = 1 << 20;

/**
 * SSE transform: verifies and canonicalizes the `model` field of EVERY JSON `data` event before
 * it is forwarded. Events are assembled per the SSE spec (lines up to a blank line; `\n` or
 * `\r\n` endings; `data:` with or without a following space; multi-line `data` joined with `\n`).
 * Events without data, `[DONE]`, comments and non-JSON payloads pass through byte-for-byte.
 *
 * enforce: a mismatching event, a JSON-looking event that mentions `model` but cannot be parsed
 * (unverifiable), or an event exceeding the pending bound is never forwarded; the stream errors.
 * shadow: all of those are passed through unchanged and reported once through `onShadowMismatch`.
 */
export class ServedIdentityGuard extends Transform {
  private partial = "";
  private event: string[] = [];
  private eventChars = 0;
  private bypass = false;
  private shadowCounted = false;
  private readonly decoder = new StringDecoder("utf8");

  private readonly subject: { kind: "check"; id: string } | { kind: "unverifiable" };

  constructor(
    requested: { kind: "check"; id: string } | { kind: "unverifiable" } | string,
    private readonly aliases: ServedModelAliasMap,
    private readonly mode: "shadow" | "enforce",
    private readonly onShadowMismatch: () => void = () => {},
  ) {
    super();
    this.subject = typeof requested === "string" ? { kind: "check", id: requested } : requested;
  }

  private flaw(reason: "mismatch" | "unverifiable" | "overflow"): void {
    if (this.mode === "enforce") throw new ServedIdentityMismatchError(reason);
    if (!this.shadowCounted) {
      this.shadowCounted = true;
      this.onShadowMismatch();
    }
  }

  /** Reconcile one complete event (raw lines incl. endings, last one blank). */
  private reconcileEvent(lines: string[]): string {
    const raw = lines.join("");
    const dataParts: string[] = [];
    const otherLines: string[] = [];
    for (const line of lines) {
      const body = line.replace(/\r?\n$/, "");
      if (body.startsWith("data:")) dataParts.push(body.slice(5));
      else if (body !== "") otherLines.push(line);
    }
    if (dataParts.length === 0) return raw;
    const data = dataParts.join("\n");
    const trimmed = data.trim();
    // Fast path: no `model` key can be present (also guard against unicode-escaped key names).
    if (!data.includes('"model"') && !data.includes("\\u")) return raw;
    if (trimmed === "[DONE]") return raw;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) this.flaw("unverifiable");
      return raw;
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) return raw;
    const obj = json as Record<string, unknown>;
    if (!("model" in obj)) return raw;
    const verdict = judgeSubject(this.subject, obj["model"], this.aliases);
    if (verdict === "mismatch") {
      this.flaw("mismatch");
      return raw;
    }
    if (verdict !== "aliased" || this.subject.kind !== "check") return raw;
    const eol = /\r\n$/.test(lines[0] ?? "") ? "\r\n" : "\n";
    return `${otherLines.join("")}data: ${JSON.stringify({ ...obj, model: this.subject.id })}${eol}${eol}`;
  }

  private consume(text: string, final: boolean): string {
    let out = "";
    this.partial += text;
    let pos = 0;
    for (;;) {
      const nl = this.partial.indexOf("\n", pos);
      if (nl === -1) break;
      const line = this.partial.slice(pos, nl + 1);
      pos = nl + 1;
      out += this.acceptLine(line);
    }
    this.partial = this.partial.slice(pos);
    if (final && this.partial !== "") {
      out += this.acceptLine(this.partial);
      this.partial = "";
    }
    if (final && this.event.length > 0) {
      const pending = this.event;
      this.event = [];
      this.eventChars = 0;
      out += this.bypass ? pending.join("") : this.reconcileEvent(pending);
    }
    if (!final && this.partial.length > MAX_PENDING_SSE_EVENT_CHARS) {
      // An unterminated line alone is already past the bound.
      this.flaw("overflow");
      out += this.event.join("") + this.partial;
      this.event = [];
      this.eventChars = 0;
      this.partial = "";
      this.bypass = true;
    }
    return out;
  }

  private acceptLine(line: string): string {
    if (this.bypass) {
      if (/^\r?\n$/.test(line)) this.bypass = false;
      return line;
    }
    this.event.push(line);
    this.eventChars += line.length;
    if (/^\r?\n$/.test(line)) {
      const lines = this.event;
      this.event = [];
      this.eventChars = 0;
      return this.reconcileEvent(lines);
    }
    if (this.eventChars > MAX_PENDING_SSE_EVENT_CHARS) {
      this.flaw("overflow");
      const raw = this.event.join("");
      this.event = [];
      this.eventChars = 0;
      this.bypass = true;
      return raw;
    }
    return "";
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const out = this.consume(this.decoder.write(chunk), false);
      callback(null, out === "" ? undefined : out);
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      const out = this.consume(this.decoder.end(), true);
      callback(null, out === "" ? undefined : out);
    } catch (err) {
      callback(err as Error);
    }
  }
}

/** Roster IDs named in the alias map that are absent from the live roster (log these, never served values). */
export function unknownAliasRosterIds(aliases: ServedModelAliasMap, roster: ReadonlySet<string>): string[] {
  return [...aliases.keys()].filter((id) => !roster.has(id));
}
