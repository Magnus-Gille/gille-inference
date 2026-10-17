/** Pure, bounded validation for multimodal embedding input. */

const MAX_INPUTS = 4;
const MAX_PARTS = 4;
const MAX_TEXT_CHARS = 16 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type AudioPart = { type: "input_audio"; input_audio: { data: string } };
type VideoPart = { type: "input_video"; input_video: { data: string } };

export type EmbeddingMediaPart = TextPart | ImagePart | AudioPart | VideoPart;
export type EmbeddingMediaItem = { content: EmbeddingMediaPart[] };

export interface EmbeddingMediaInputResult {
  input: EmbeddingMediaItem[];
  hasMedia: boolean;
}

/** Deliberately contains no user supplied value, so malformed content cannot enter logs. */
export class EmbeddingMediaError extends Error {
  constructor(message = "Invalid embedding media input.") {
    super(message);
    this.name = "EmbeddingMediaError";
  }
}

function invalid(): never {
  throw new EmbeddingMediaError();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function decodeBase64(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid();
  // Check the encoded bound before handing attacker-controlled input to Buffer.
  const maximumEncoded = 4 * Math.ceil(maximumBytes / 3);
  if (value.length > maximumEncoded) invalid();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes ||
    decoded.toString("base64") !== value) invalid();
  return decoded;
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  return bytes.toString("ascii", offset, offset + length);
}

function validatePng(bytes: Buffer): void {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8;
  let width = 0;
  let height = 0;
  let foundHeader = false;
  let foundData = false;
  let foundEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const chunkData = bytes.subarray(dataStart, dataStart + length);
    const checksum = bytes.readUInt32BE(dataStart + length);
    const checksumInput = Buffer.concat([Buffer.from(type, "ascii"), chunkData]);
    if (crc32(checksumInput) !== checksum) invalid();
    if (!foundHeader && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (foundHeader || length !== 13) invalid();
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      foundHeader = true;
    } else if (type === "IDAT") {
      if (!foundHeader || length === 0) invalid();
      foundData = true;
    } else if (type === "IEND") {
      if (length !== 0 || foundEnd || !foundData) invalid();
      foundEnd = true;
      if (end !== bytes.length) invalid();
    }
    offset = end;
  }
  if (!foundHeader || !foundData || !foundEnd || width < 1 || height < 1 || width > 2048 || height > 2048) invalid();
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateJpeg(bytes: Buffer): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2;
  let dimensions: [number, number] | undefined;
  let foundEoi = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalid();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9) {
      foundEoi = true;
      break;
    }
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) invalid();
      const scanLength = bytes.readUInt16BE(offset);
      if (scanLength < 2 || offset + scanLength > bytes.length) invalid();
      offset += scanLength;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const scanMarker = bytes[offset + 1]!;
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (scanMarker === 0xd9) {
          foundEoi = true;
          offset += 2;
          break;
        }
        // A non-stuffed, non-restart marker terminates this entropy-coded scan. Leave
        // the marker in place so the outer loop can parse DHT/SOS and other segments.
        break;
      }
      if (foundEoi) break;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) invalid();
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) invalid();
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (segmentLength < 7) invalid();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      dimensions = [width, height];
    }
    offset += segmentLength;
  }
  if (!dimensions || !foundEoi || dimensions[0] < 1 || dimensions[1] < 1 || dimensions[0] > 2048 || dimensions[1] > 2048) invalid();
}

function validateImage(dataUri: unknown): void {
  if (typeof dataUri !== "string") invalid();
  const match = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(dataUri);
  if (!match) invalid();
  const bytes = decodeBase64(match[2], MAX_IMAGE_BYTES);
  if (match[1] === "image/png") validatePng(bytes);
  else validateJpeg(bytes);
}

function validateWav(bytes: Buffer): void {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE" ||
    bytes.readUInt32LE(4) !== bytes.length - 8) invalid();
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataSize = 0;
  let foundFmt = false;
  let foundData = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.length) invalid();
    const type = ascii(bytes, offset, 4);
    if (type === "fmt ") {
      if (size < 16 || foundFmt) invalid();
      const start = offset + 8;
      if (bytes.readUInt16LE(start) !== 1) invalid();
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      blockAlign = bytes.readUInt16LE(start + 12);
      bitsPerSample = bytes.readUInt16LE(start + 14);
      if (channels < 1 || sampleRate < 1 || blockAlign < 1 || bitsPerSample < 8 ||
        bitsPerSample > 32 || bitsPerSample % 8 !== 0 || blockAlign !== channels * bitsPerSample / 8) invalid();
      foundFmt = true;
    } else if (type === "data") {
      if (foundData || size === 0) invalid();
      dataSize = size;
      foundData = true;
    }
    offset = end + (size % 2);
    if (offset > bytes.length) invalid();
  }
  if (!foundFmt || !foundData || dataSize % blockAlign !== 0) invalid();
  const duration = dataSize / blockAlign / sampleRate;
  if (!Number.isFinite(duration) || duration > 30) invalid();
}

interface Box { type: string; start: number; payload: number; end: number }

function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const result: Box[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) invalid();
    let size = bytes.readUInt32BE(offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) invalid();
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      invalid();
    }
    if (size < header || offset + size > end) invalid();
    result.push({ type, start: offset, payload: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function child(bytes: Buffer, parent: Box, type: string): Box | undefined {
  return boxes(bytes, parent.payload, parent.end).find((box) => box.type === type);
}

function uint64(bytes: Buffer, offset: number): bigint {
  return bytes.readBigUInt64BE(offset);
}

function validateMp4(bytes: Buffer): void {
  const top = boxes(bytes, 0, bytes.length);
  const ftyp = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  if (!ftyp || ftyp.payload + 8 > ftyp.end || !moov || top.some((box) => box.type === "moof") ||
    child(bytes, moov, "mvex")) invalid();
  const mvhd = child(bytes, moov, "mvhd");
  if (!mvhd || mvhd.payload + 1 > mvhd.end) invalid();
  const mvhdVersion = bytes[mvhd.payload]!;
  if (mvhdVersion > 1 || mvhd.payload + (mvhdVersion === 1 ? 32 : 20) > mvhd.end) invalid();
  const movieTimescale = bytes.readUInt32BE(mvhd.payload + (mvhdVersion === 1 ? 20 : 12));
  const movieDuration = mvhdVersion === 1 ? uint64(bytes, mvhd.payload + 24) : BigInt(bytes.readUInt32BE(mvhd.payload + 16));
  if (movieTimescale === 0 || movieDuration > BigInt(movieTimescale * 10)) invalid();

  let videoFound = false;
  for (const trak of boxes(bytes, moov.payload, moov.end).filter((box) => box.type === "trak")) {
    const mdia = child(bytes, trak, "mdia");
    if (!mdia) invalid();
    const hdlr = child(bytes, mdia, "hdlr");
    if (!hdlr || hdlr.payload + 12 > hdlr.end) invalid();
    if (ascii(bytes, hdlr.payload + 8, 4) !== "vide") continue;
    if (videoFound) invalid();
    videoFound = true;
    const mdhd = child(bytes, mdia, "mdhd");
    const minf = child(bytes, mdia, "minf");
    const stbl = minf && child(bytes, minf, "stbl");
    const stsd = stbl && child(bytes, stbl, "stsd");
    const stts = stbl && child(bytes, stbl, "stts");
    const stsz = stbl && child(bytes, stbl, "stsz");
    if (!mdhd || !stsd || !stts || !stsz || stsd.payload + 8 > stsd.end || stts.payload + 8 > stts.end ||
      stsz.payload + 12 > stsz.end || bytes.readUInt32BE(stsd.payload + 4) === 0) invalid();
    const sampleDescriptionCount = bytes.readUInt32BE(stsd.payload + 4);
    if (sampleDescriptionCount !== 1) invalid();
    const sampleEntry = stsd.payload + 8;
    if (sampleEntry + 86 > stsd.end) invalid();
    const sampleEntrySize = bytes.readUInt32BE(sampleEntry);
    const sampleEntryType = ascii(bytes, sampleEntry + 4, 4);
    if (sampleEntrySize < 86 || sampleEntry + sampleEntrySize > stsd.end ||
      !["mp4v", "avc1", "avc2", "avc3", "avc4", "hvc1", "hev1", "av01", "vp09"].includes(sampleEntryType)) invalid();
    const videoWidth = bytes.readUInt16BE(sampleEntry + 32);
    const videoHeight = bytes.readUInt16BE(sampleEntry + 34);
    if (videoWidth < 1 || videoHeight < 1 || videoWidth > 2048 || videoHeight > 2048) invalid();
    const mdhdVersion = bytes[mdhd.payload]!;
    const mdhdTimescaleOffset = mdhdVersion === 1 ? 20 : 12;
    const mdhdDurationOffset = mdhdVersion === 1 ? 24 : 16;
    if (mdhdVersion > 1 || mdhd.payload + mdhdDurationOffset + (mdhdVersion === 1 ? 8 : 4) > mdhd.end) invalid();
    const timescale = bytes.readUInt32BE(mdhd.payload + mdhdTimescaleOffset);
    const duration = mdhdVersion === 1 ? uint64(bytes, mdhd.payload + mdhdDurationOffset) : BigInt(bytes.readUInt32BE(mdhd.payload + mdhdDurationOffset));
    if (timescale === 0 || duration > BigInt(timescale * 10)) invalid();
    const entryCount = bytes.readUInt32BE(stts.payload + 4);
    if (entryCount === 0 || stts.payload + 8 + entryCount * 8 > stts.end) invalid();
    let samples = 0n;
    let ticks = 0n;
    for (let i = 0; i < entryCount; i += 1) {
      const at = stts.payload + 8 + i * 8;
      samples += BigInt(bytes.readUInt32BE(at));
      ticks += BigInt(bytes.readUInt32BE(at + 4)) * BigInt(bytes.readUInt32BE(at));
    }
    const sampleSize = bytes.readUInt32BE(stsz.payload + 4);
    const sampleCount = bytes.readUInt32BE(stsz.payload + 8);
    if (sampleCount === 0 || samples !== BigInt(sampleCount) || samples > 64n || ticks > BigInt(timescale * 10)) invalid();
    if (sampleSize === 0 && stsz.payload + 12 + sampleCount * 4 > stsz.end) invalid();
  }
  if (!videoFound) invalid();
}

function parsePart(value: unknown): { part: EmbeddingMediaPart; media: boolean } {
  if (!record(value) || typeof value["type"] !== "string") invalid();
  const type = value["type"];
  if (type === "text") {
    if (!exactKeys(value, ["type", "text"]) || typeof value["text"] !== "string" ||
      value["text"].length === 0 || value["text"].length > MAX_TEXT_CHARS) invalid();
    return { part: { type, text: value["text"] }, media: false };
  }
  if (type === "image_url") {
    const image = value["image_url"];
    if (!exactKeys(value, ["type", "image_url"]) || !record(image) || !exactKeys(image, ["url"])) invalid();
    validateImage(image["url"]);
    return { part: { type, image_url: { url: image["url"] as string } }, media: true };
  }
  if (type === "input_audio" || type === "input_video") {
    const field = type === "input_audio" ? "input_audio" : "input_video";
    const nested = value[field];
    if (!exactKeys(value, ["type", field]) || !record(nested) || !exactKeys(nested, ["data", "format"]) ||
      nested["format"] !== (type === "input_audio" ? "wav" : "mp4")) invalid();
    const bytes = decodeBase64(nested["data"], type === "input_audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES);
    if (type === "input_audio") validateWav(bytes);
    else validateMp4(bytes);
    return type === "input_audio"
      ? { part: { type, input_audio: { data: nested["data"] as string } }, media: true }
      : { part: { type, input_video: { data: nested["data"] as string } }, media: true };
  }
  invalid();
}

/** Validate and rebuild the exact upstream multimodal shape without retaining arbitrary fields. */
export function parseEmbeddingMediaInput(value: unknown): EmbeddingMediaInputResult {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INPUTS) invalid();
  let hasMedia = false;
  let videoCount = 0;
  const input: EmbeddingMediaItem[] = [];
  for (const item of value) {
    if (!record(item) || !exactKeys(item, ["content"]) || !Array.isArray(item["content"]) ||
      item["content"].length < 1 || item["content"].length > MAX_PARTS) invalid();
    const content: EmbeddingMediaPart[] = [];
    for (const rawPart of item["content"]) {
      const parsed = parsePart(rawPart);
      if (parsed.part.type === "input_video") videoCount += 1;
      if (videoCount > 1) invalid();
      hasMedia ||= parsed.media;
      content.push(parsed.part);
    }
    input.push({ content });
  }
  return { input, hasMedia };
}
