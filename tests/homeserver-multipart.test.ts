import { describe, it, expect } from "vitest";
import { parseMultipart, type MultipartFile } from "../src/homeserver/multipart.js";

/**
 * Unit tests for the hand-rolled, BINARY-SAFE multipart/form-data parser.
 *
 * The critical property is that arbitrary binary file bytes (audio) survive parsing byte-for-byte
 * — a naive utf-8 round-trip would corrupt them. We assert that explicitly with a buffer that
 * contains the CRLF/boundary-like byte sequences and the full 0x00–0xFF range.
 */

/** Build a multipart/form-data body Buffer from text fields + one file part. */
function buildBody(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; filename: string; contentType: string; data: Buffer } | null
): Buffer {
  const parts: Buffer[] = [];
  const dashBoundary = `--${boundary}\r\n`;
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(dashBoundary, "utf-8"));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${k}"\r\n\r\n`, "utf-8"));
    parts.push(Buffer.from(v, "utf-8"));
    parts.push(Buffer.from("\r\n", "utf-8"));
  }
  if (file) {
    parts.push(Buffer.from(dashBoundary, "utf-8"));
    parts.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf-8"
      )
    );
    parts.push(file.data);
    parts.push(Buffer.from("\r\n", "utf-8"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));
  return Buffer.concat(parts);
}

describe("parseMultipart — binary-safe multipart/form-data parser", () => {
  it("parses simple text fields", () => {
    const boundary = "BOUND123";
    const body = buildBody(boundary, { language: "sv", response_format: "json" }, null);
    const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parsed.fields["language"]).toBe("sv");
    expect(parsed.fields["response_format"]).toBe("json");
    expect(parsed.files.length).toBe(0);
  });

  it("extracts a file part with filename + content type", () => {
    const boundary = "BOUNDfile";
    const audio = Buffer.from("RIFFfakeWAVdata", "utf-8");
    const body = buildBody(boundary, { model: "whisper-1" }, {
      name: "file",
      filename: "clip.wav",
      contentType: "audio/wav",
      data: audio,
    });
    const parsed = parseMultipart(body, `multipart/form-data; boundary="${boundary}"`);
    expect(parsed.fields["model"]).toBe("whisper-1");
    expect(parsed.files.length).toBe(1);
    const f = parsed.files[0] as MultipartFile;
    expect(f.name).toBe("file");
    expect(f.filename).toBe("clip.wav");
    expect(f.contentType).toBe("audio/wav");
    expect(f.data.equals(audio)).toBe(true);
  });

  it("preserves arbitrary BINARY file bytes byte-for-byte (0x00–0xFF, embedded CRLF/boundary-like bytes)", () => {
    const boundary = "BinBound";
    // 0x00..0xFF, then bytes that LOOK like a CRLF + boundary delimiter mid-payload — a naive
    // parser would either corrupt the high bytes (utf-8) or split the part early on the fake
    // delimiter. A correct binary parser keeps every byte.
    const ramp = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const trap = Buffer.from(`\r\n--${boundary}-not-the-real-end\r\n`, "utf-8");
    const audio = Buffer.concat([ramp, trap, ramp]);
    const body = buildBody(boundary, {}, {
      name: "file",
      filename: "a.bin",
      contentType: "application/octet-stream",
      data: audio,
    });
    const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0]!.data.length).toBe(audio.length);
    expect(parsed.files[0]!.data.equals(audio)).toBe(true);
  });

  it("throws when the content-type is not multipart/form-data", () => {
    expect(() => parseMultipart(Buffer.from("x"), "application/json")).toThrow();
  });

  it("throws when no boundary is present in the content-type", () => {
    expect(() => parseMultipart(Buffer.from("x"), "multipart/form-data")).toThrow();
  });
});
