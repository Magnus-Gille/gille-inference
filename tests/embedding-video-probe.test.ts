import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EmbeddingVideoProbeError,
  validateEmbeddingVideoBitstream,
} from "../src/homeserver/embedding-video-probe.js";
import type { EmbeddingMediaItem } from "../src/homeserver/embedding-media.js";

const tempDirectories: string[] = [];

function input(data = Buffer.from("bounded-mp4").toString("base64")): EmbeddingMediaItem[] {
  return [{ content: [{ type: "input_video", input_video: { data } }] }];
}

async function probeScript(json: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "embedding-video-probe-"));
  tempDirectories.push(directory);
  const path = join(directory, "ffprobe");
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${json.replaceAll("'", "'\\''")}'\n`);
  await chmod(path, 0o700);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("embedding video bitstream probe", () => {
  it("skips text-only sanitized input", async () => {
    await expect(validateEmbeddingVideoBitstream([{ content: [{ type: "text", text: "hello" }] }])).resolves.toBeUndefined();
  });

  it("accepts one bounded video stream with measured limits", async () => {
    const path = await probeScript(JSON.stringify({
      streams: [{ codec_type: "video", width: 1920, height: 1080, nb_read_frames: "64", duration: "9.5" }],
      format: { duration: "9.5" },
    }));
    await expect(validateEmbeddingVideoBitstream(input(), path)).resolves.toBeUndefined();
  });

  it.each([
    ["no video stream", { streams: [], format: { duration: "1" } }],
    ["multiple video streams", { streams: [
      { codec_type: "video", width: 1, height: 1, nb_read_frames: "1", duration: "1" },
      { codec_type: "video", width: 1, height: 1, nb_read_frames: "1", duration: "1" },
    ], format: { duration: "1" } }],
    ["oversized dimensions", { streams: [{ codec_type: "video", width: 2049, height: 1, nb_read_frames: "1" }], format: { duration: "1" } }],
    ["too many actual frames", { streams: [{ codec_type: "video", width: 1, height: 1, nb_read_frames: "65" }], format: { duration: "1" } }],
    ["too long actual duration", { streams: [{ codec_type: "video", width: 1, height: 1, nb_read_frames: "1" }], format: { duration: "10.1" } }],
  ])("rejects %s without exposing probe data", async (_label, result) => {
    const path = await probeScript(JSON.stringify(result));
    await expect(validateEmbeddingVideoBitstream(input(), path)).rejects.toBeInstanceOf(EmbeddingVideoProbeError);
    await expect(validateEmbeddingVideoBitstream(input(), path)).rejects.toThrow("Video bitstream validation failed.");
  });

  it("returns a content-blind error when ffprobe cannot start", async () => {
    await expect(validateEmbeddingVideoBitstream(input(), "/tmp/does-not-exist-ffprobe"))
      .rejects.toBeInstanceOf(EmbeddingVideoProbeError);
  });
});
