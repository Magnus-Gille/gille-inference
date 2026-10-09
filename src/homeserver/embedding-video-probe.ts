/** Bounded secondary bitstream validation for already-sanitized embedding video input. */
import { spawn } from "node:child_process";
import type { EmbeddingMediaItem } from "./embedding-media.js";

const DEFAULT_FFPROBE = "/usr/bin/ffprobe";
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_DIMENSION = 2_048;
const MAX_FRAMES = 64;
const MAX_DURATION_SECONDS = 10;

/** Deliberately contains no input, stderr, or parser detail. */
export class EmbeddingVideoProbeError extends Error {
  constructor() {
    super("Video bitstream validation failed.");
    this.name = "EmbeddingVideoProbeError";
  }
}

function fail(): never {
  throw new EmbeddingVideoProbeError();
}

function videoData(input: EmbeddingMediaItem[]): string | undefined {
  let data: string | undefined;
  for (const item of input) {
    for (const part of item.content) {
      if (part.type !== "input_video") continue;
      if (data !== undefined || typeof part.input_video.data !== "string") fail();
      data = part.input_video.data;
    }
  }
  return data;
}

function decodeVideo(data: string): Buffer {
  const maximumEncoded = 4 * Math.ceil(MAX_VIDEO_BYTES / 3);
  if (data.length === 0 || data.length > maximumEncoded || data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail();
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_VIDEO_BYTES || bytes.toString("base64") !== data) fail();
  return bytes;
}

interface ProbeOutput {
  streams?: unknown;
  format?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProbeOutput(raw: Buffer): void {
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as ProbeOutput;
  } catch {
    fail();
  }
  if (!record(parsed) || !Array.isArray(parsed.streams)) fail();
  const videoStreams = parsed.streams.filter((stream): stream is Record<string, unknown> =>
    record(stream) && stream["codec_type"] === "video");
  if (videoStreams.length !== 1) fail();
  const stream = videoStreams[0]!;
  const width = finiteNumber(stream["width"]);
  const height = finiteNumber(stream["height"]);
  if (width === undefined || height === undefined || !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) fail();

  const frames = finiteNumber(stream["nb_read_frames"] ?? stream["nb_frames"]);
  if (frames === undefined || !Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) fail();

  const format = record(parsed.format) ? finiteNumber(parsed.format["duration"]) : undefined;
  const duration = format ?? finiteNumber(stream["duration"]);
  if (duration === undefined || duration < 0 || duration > MAX_DURATION_SECONDS) fail();
}

/** Run ffprobe on the one sanitized inline MP4 video, if present. */
export function validateEmbeddingVideoBitstream(
  input: EmbeddingMediaItem[],
  binaryPath = DEFAULT_FFPROBE,
): Promise<void> {
  const data = videoData(input);
  if (data === undefined) return Promise.resolve();
  const bytes = decodeVideo(data);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, [
      "-v", "error",
      "-protocol_whitelist", "pipe",
      "-f", "mp4",
      "-count_frames",
      "-show_entries", "stream=codec_type,width,height,nb_read_frames,nb_frames,duration:format=duration",
      "-of", "json",
      "-i", "pipe:0",
    ], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });

    let outputSize = 0;
    const output: Buffer[] = [];
    let failed = false;
    let settled = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);

    const rejectOnce = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new EmbeddingVideoProbeError());
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytesRead = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (outputSize + bytesRead > MAX_OUTPUT_BYTES) {
        failed = true;
        child.kill("SIGKILL");
        return;
      }
      outputSize += bytesRead;
      output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stdin.on("error", () => undefined);
    child.once("error", () => {
      failed = true;
      child.kill("SIGKILL");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        rejectOnce();
        return;
      }
      try {
        validateProbeOutput(Buffer.concat(output, outputSize));
        if (!settled) {
          settled = true;
          resolve();
        }
      } catch {
        rejectOnce();
      }
    });

    try {
      child.stdin.end(bytes);
    } catch {
      failed = true;
      child.kill("SIGKILL");
    }
  });
}
