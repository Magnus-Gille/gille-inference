import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { EmbeddingMediaError, parseEmbeddingMediaInput } from "../src/homeserver/embedding-media.js";

const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02,
  0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]).toString("base64");

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width = 2, height = 2): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const header = Buffer.from(type, "ascii");
    const body = Buffer.concat([header, data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) scanlines[row * (1 + width * 4)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function dataUri(mime: string, value: string): string {
  return `data:${mime};base64,${value}`;
}

function wav(seconds = 1): string {
  const sampleRate = 8_000;
  const channels = 1;
  const bits = 16;
  const dataSize = sampleRate * channels * (bits / 8) * seconds;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  out.writeUInt16LE(channels * (bits / 8), 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize, 40);
  return out.toString("base64");
}

function mp4(frameCount = 2, durationSeconds = 1): string {
  const box = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(out.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    return out;
  };
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(0, 0);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(durationSeconds * 1_000, 16);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(0, 0);
  mdhd.writeUInt32BE(1_000, 12);
  mdhd.writeUInt32BE(durationSeconds * 1_000, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.writeUInt32BE(0, 0);
  hdlr.write("vide", 8, "ascii");
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(0, 0);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(frameCount, 8);
  stts.writeUInt32BE(Math.max(1, Math.floor((durationSeconds * 1_000) / frameCount)), 12);
  const stsz = Buffer.alloc(12 + frameCount * 4);
  stsz.writeUInt32BE(0, 0);
  stsz.writeUInt32BE(0, 4);
  stsz.writeUInt32BE(frameCount, 8);
  for (let i = 0; i < frameCount; i += 1) stsz.writeUInt32BE(1, 12 + i * 4);
  const stsd = Buffer.alloc(16);
  stsd.writeUInt32BE(0, 0);
  stsd.writeUInt32BE(1, 4);
  const stbl = box("stbl", Buffer.concat([box("stsd", stsd), box("stts", stts), box("stsz", stsz)]));
  const minf = box("minf", stbl);
  const mdia = box("mdia", Buffer.concat([box("mdhd", mdhd), box("hdlr", hdlr), minf]));
  const trak = box("trak", mdia);
  const moov = box("moov", Buffer.concat([box("mvhd", mvhd), trak]));
  const ftypBody = Buffer.alloc(8);
  ftypBody.write("isom", 0, "ascii");
  ftypBody.writeUInt32BE(0, 4);
  return Buffer.concat([box("ftyp", ftypBody), moov]).toString("base64");
}

describe("embedding media input", () => {
  it("preserves sanitized text and accepted inline image/audio/video parts", () => {
    const result = parseEmbeddingMediaInput([{
      content: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: dataUri("image/png", png()) } },
        { type: "input_audio", input_audio: { data: wav(), format: "wav" } },
        { type: "input_video", input_video: { data: mp4(), format: "mp4" } },
      ],
    }]);
    expect(result.hasMedia).toBe(true);
    expect(result.input).toEqual([{
      content: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: dataUri("image/png", png()) } },
        { type: "input_audio", input_audio: { data: wav() } },
        { type: "input_video", input_video: { data: mp4() } },
      ],
    }]);
  });

  it("accepts text only and marks it as non-media", () => {
    expect(parseEmbeddingMediaInput([{ content: [{ type: "text", text: "hello" }] }])).toEqual({
      input: [{ content: [{ type: "text", text: "hello" }] }], hasMedia: false,
    });
  });

  it("accepts an inline JPEG after validating its frame dimensions", () => {
    expect(parseEmbeddingMediaInput([{ content: [{ type: "image_url", image_url: {
      url: dataUri("image/jpeg", jpeg),
    } }] }]).hasMedia).toBe(true);
  });

  it.each([
    "https://example.invalid/a.png",
    "file:///tmp/a.png",
    dataUri("image/png", "not-base64"),
    dataUri("image/gif", png()),
  ])("rejects unsafe or malformed image URL %s", (url) => {
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "image_url", image_url: { url } }] }]))
      .toThrow(EmbeddingMediaError);
  });

  it("rejects malformed audio, unsupported video, and duplicate videos", () => {
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "input_audio", input_audio: { data: "bad", format: "wav" } }] }]))
      .toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "input_video", input_video: { data: wav(), format: "mp4" } }] }]))
      .toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([
      { content: [{ type: "input_video", input_video: { data: mp4(), format: "mp4" } }] },
      { content: [{ type: "input_video", input_video: { data: mp4(), format: "mp4" } }] },
    ])).toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "unknown", value: "x" }] }]))
      .toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "input_video", input_video: {
      data: mp4().slice(0, -8), format: "mp4",
    } }] }])).toThrow(EmbeddingMediaError);
  });

  it("enforces part and vector counts", () => {
    expect(() => parseEmbeddingMediaInput([{ content: Array.from({ length: 5 }, () => ({ type: "text", text: "x" })) }]))
      .toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput(Array.from({ length: 5 }, () => ({ content: [{ type: "text", text: "x" }] }))))
      .toThrow(EmbeddingMediaError);
  });

  it("enforces image dimensions, audio duration, and video frame and duration bounds", () => {
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "image_url", image_url: {
      url: dataUri("image/png", png(2049, 1)),
    } }] }])).toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "input_audio", input_audio: { data: wav(31), format: "wav" } }] }]))
      .toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "input_video", input_video: { data: mp4(65), format: "mp4" } }] }]))
      .toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "input_video", input_video: { data: mp4(1, 11), format: "mp4" } }] }]))
      .toThrow(EmbeddingMediaError);
  });

  it("rejects truncated PNG and JPEG payloads", () => {
    const pngBytes = Buffer.from(png(), "base64");
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "image_url", image_url: {
      url: dataUri("image/png", pngBytes.subarray(0, -12).toString("base64")),
    } }] }])).toThrow(EmbeddingMediaError);
    expect(() => parseEmbeddingMediaInput([{ content: [{ type: "image_url", image_url: {
      url: dataUri("image/jpeg", Buffer.from(jpeg, "base64").subarray(0, -2).toString("base64")),
    } }] }])).toThrow(EmbeddingMediaError);
  });
});
