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

export type CompletionIdentityResult =
  | { kind: "unchanged"; text: string }
  | { kind: "rewritten"; text: string }
  | { kind: "mismatch" };

/**
 * Reconcile a buffered (non-streaming) chat completion body. A body that is not a JSON object
 * carries no identity claim and is left to the caller's existing handling.
 */
export function reconcileCompletionIdentity(
  text: string,
  requested: string | null,
  aliases: ServedModelAliasMap,
): CompletionIdentityResult {
  if (requested === null) return { kind: "unchanged", text };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unchanged", text };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return { kind: "unchanged", text };
  const obj = json as Record<string, unknown>;
  const verdict = judgeServedIdentity(requested, obj["model"], aliases);
  if (verdict === "mismatch") return { kind: "mismatch" };
  if (verdict !== "aliased") return { kind: "unchanged", text };
  return { kind: "rewritten", text: JSON.stringify({ ...obj, model: requested }) };
}

/** Raised by {@link ServedIdentityGuard}; carries no identity text by design. */
export class ServedIdentityMismatchError extends Error {
  constructor() {
    super("served model identity mismatch");
    this.name = "ServedIdentityMismatchError";
  }
}

/**
 * SSE transform: verifies and canonicalizes the `model` field of EVERY `data:` JSON frame before
 * it is forwarded. Frames without a `model` key, comments, `[DONE]` and non-JSON payloads pass
 * through byte-for-byte. A mismatching frame is never forwarded; the stream errors instead.
 */
export class ServedIdentityGuard extends Transform {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly requested: string,
    private readonly aliases: ServedModelAliasMap,
  ) {
    super();
  }

  private reconcileLine(line: string): string {
    const m = /^data:[ \t]?(\{.*\})([\r\n]*)$/s.exec(line);
    if (m === null) return line;
    let json: unknown;
    try {
      json = JSON.parse(m[1]!);
    } catch {
      return line;
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) return line;
    const obj = json as Record<string, unknown>;
    if (!("model" in obj)) return line;
    const verdict = judgeServedIdentity(this.requested, obj["model"], this.aliases);
    if (verdict === "mismatch") throw new ServedIdentityMismatchError();
    if (verdict !== "aliased") return line;
    return `data: ${JSON.stringify({ ...obj, model: this.requested })}${m[2]!}`;
  }

  private drain(final: boolean): string {
    let out = "";
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      out += this.reconcileLine(this.buffer.slice(0, nl + 1));
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
    }
    if (final && this.buffer !== "") {
      out += this.reconcileLine(this.buffer);
      this.buffer = "";
    }
    return out;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer += this.decoder.write(chunk);
      const out = this.drain(false);
      callback(null, out === "" ? undefined : out);
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.buffer += this.decoder.end();
      const out = this.drain(true);
      callback(null, out === "" ? undefined : out);
    } catch (err) {
      callback(err as Error);
    }
  }
}
