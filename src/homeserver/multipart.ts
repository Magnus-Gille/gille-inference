/**
 * Minimal, BINARY-SAFE multipart/form-data parser.
 *
 * Hand-rolled (no busboy / no external dep) to match the codebase's zero-extra-dependency ethos
 * for the homeserver gateway. It operates entirely on the raw request Buffer and slices file
 * bytes out by byte offset, so arbitrary binary payloads (audio) survive byte-for-byte — there is
 * NO utf-8 round-trip of the body. Only the small header block of each part is decoded as text.
 *
 * Scope is deliberately narrow: enough of RFC 7578 to handle the OpenAI Whisper
 * `POST /v1/audio/transcriptions` shape (a single audio file part + a handful of text fields).
 * It does not implement nested multipart, transfer-encoding, or streaming — the gateway already
 * caps the body size before this runs.
 */

export interface MultipartFile {
  /** The form field name (e.g. "file"). */
  name: string;
  /** The client-provided filename, or null when absent. */
  filename: string | null;
  /** The part's declared Content-Type, or null when absent. */
  contentType: string | null;
  /** The raw file bytes, byte-for-byte. */
  data: Buffer;
}

export interface ParsedMultipart {
  /** Non-file form fields, decoded as utf-8 text. */
  fields: Record<string, string>;
  /** File parts (any part with a filename in its Content-Disposition). */
  files: MultipartFile[];
}

/** Extract the boundary token from a `multipart/form-data; boundary=...` content-type header. */
function extractBoundary(contentType: string): string | null {
  if (!/^multipart\/form-data/i.test(contentType.trim())) return null;
  const m = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim() || null;
}

/** Find the index of `needle` in `haystack` at or after `from`. -1 if not present. */
function indexOf(haystack: Buffer, needle: Buffer, from: number): number {
  return haystack.indexOf(needle, from);
}

/**
 * Find the next REAL boundary delimiter at or after `from`. A delimiter is `--boundary` whose
 * trailing bytes are a valid terminator — `--` (the closing delimiter) or optional linear
 * whitespace then CRLF (a part delimiter). This rejects a `--boundary`-LIKE byte sequence that
 * happens to occur inside binary payload but is NOT a true delimiter (e.g. `--boundary-foo`),
 * which a naive substring search would mistake for the end of the part and truncate the file.
 */
function findDelimiter(body: Buffer, delimiter: Buffer, from: number): number {
  let at = indexOf(body, delimiter, from);
  while (at !== -1) {
    let p = at + delimiter.length;
    // Closing delimiter: --boundary--
    if (body[p] === 0x2d && body[p + 1] === 0x2d) return at;
    // Part delimiter: --boundary[ \t]*CRLF
    while (body[p] === 0x20 || body[p] === 0x09) p++; // skip optional LWS
    if (body[p] === 0x0d && body[p + 1] === 0x0a) return at;
    if (body[p] === 0x0a) return at; // tolerate a bare LF
    // Not a real delimiter (some other byte follows) — keep searching past this false match.
    at = indexOf(body, delimiter, at + delimiter.length);
  }
  return -1;
}

/** Parse one part's header block (text) into a small map of lowercased header → raw value. */
function parsePartHeaders(headerBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headerBlock.split("\r\n")) {
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Pull `name="..."` / `filename="..."` style params out of a Content-Disposition value. */
function dispositionParam(disposition: string, key: string): string | null {
  const m = new RegExp(`${key}="([^"]*)"`, "i").exec(disposition);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse a multipart/form-data body. Throws on a non-multipart content-type or a missing boundary
 * (a clean client error the caller maps to a 400). Best-effort on malformed parts within an
 * otherwise valid body — a part with no parseable headers is skipped rather than throwing.
 */
export function parseMultipart(body: Buffer, contentType: string): ParsedMultipart {
  const boundary = extractBoundary(contentType);
  if (boundary === null) {
    throw new Error("not a multipart/form-data body with a boundary");
  }

  const delimiter = Buffer.from(`--${boundary}`, "utf-8");
  const crlf = Buffer.from("\r\n", "utf-8");
  const headerSep = Buffer.from("\r\n\r\n", "utf-8");

  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  // Walk delimiter to delimiter. Each part body sits between the CRLF that ends the delimiter line
  // and the CRLF that precedes the NEXT delimiter.
  let cursor = findDelimiter(body, delimiter, 0);
  if (cursor === -1) return { fields, files };

  while (cursor !== -1) {
    // Position just after this delimiter token.
    let pos = cursor + delimiter.length;
    // A trailing "--" right after the delimiter marks the final boundary → done.
    if (body.length >= pos + 2 && body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    // Skip the CRLF that terminates the delimiter line (tolerate a bare LF / extra whitespace).
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;

    // Header block ends at the first CRLFCRLF.
    const headerEnd = indexOf(body, headerSep, pos);
    if (headerEnd === -1) break;
    const headerBlock = body.subarray(pos, headerEnd).toString("utf-8");
    const partBodyStart = headerEnd + headerSep.length;

    // The part body runs up to the CRLF immediately before the NEXT real delimiter.
    const nextDelim = findDelimiter(body, delimiter, partBodyStart);
    if (nextDelim === -1) break;
    let partBodyEnd = nextDelim;
    // Strip the CRLF that separates the part body from the next delimiter.
    if (
      partBodyEnd >= 2 &&
      body[partBodyEnd - 2] === crlf[0] &&
      body[partBodyEnd - 1] === crlf[1]
    ) {
      partBodyEnd -= 2;
    }

    const headers = parsePartHeaders(headerBlock);
    const disposition = headers["content-disposition"] ?? "";
    const name = dispositionParam(disposition, "name");
    const filename = dispositionParam(disposition, "filename");

    if (name !== null) {
      if (filename !== null) {
        // File part — slice the raw bytes (binary-safe; no utf-8 conversion of the payload).
        files.push({
          name,
          filename,
          contentType: headers["content-type"] ?? null,
          data: body.subarray(partBodyStart, partBodyEnd),
        });
      } else {
        // Plain text field.
        fields[name] = body.subarray(partBodyStart, partBodyEnd).toString("utf-8");
      }
    }

    cursor = nextDelim;
  }

  return { fields, files };
}
