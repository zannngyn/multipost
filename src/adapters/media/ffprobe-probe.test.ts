import { describe, expect, it, vi } from "vitest";

import { evaluateVideoSpec } from "@/core/domain/video-spec";
import type { Logger } from "@/core/ports/infra";

import feedFixture from "./__fixtures__/feed-16x9-5s.ffprobe.json";
import reelsFixture from "./__fixtures__/reels-9x16-10s.ffprobe.json";
import shortFixture from "./__fixtures__/reels-too-short-2s.ffprobe.json";
import { makeFfprobeMediaProbe, mapOutput } from "./ffprobe-probe";

/**
 * The fixtures are REAL ffprobe output: scripts/video-probe-smoke.ts encodes
 * three clips with ffmpeg inside a container and stores what ffprobe printed.
 * Re-run that script to refresh them.
 *
 * `mapOutput` is tested directly (no binary needed on the host); the spawn paths
 * that can be proven anywhere — a missing binary, a missing file — go through
 * the real adapter.
 */

const TARGET = { path: "/tmp/clip.mp4", sizeBytes: 1234 };

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

describe("mapOutput — malformed ffprobe output", () => {
  it("rejects output that is not JSON", () => {
    expect(() => mapOutput("ffprobe version 7.1\n", TARGET)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("keeps the reason and a stdout excerpt in the error context", () => {
    try {
      mapOutput("<html>proxy error</html>", TARGET);
      expect.unreachable("mapOutput should have thrown");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        context: { reason: "FFPROBE_OUTPUT_INVALID", stdout_head: "<html>proxy error</html>" },
      });
    }
  });

  it("rejects output whose streams are not an array", () => {
    expect(() => mapOutput(JSON.stringify({ streams: "nope" }), TARGET)).toThrowError(
      expect.objectContaining({ context: expect.objectContaining({ reason: "FFPROBE_OUTPUT_INVALID" }) }),
    );
  });

  it("rejects an audio-only file with reason NOT_A_VIDEO", () => {
    const audioOnly = JSON.stringify({
      streams: [{ codec_type: "audio", codec_name: "mp3" }],
      format: { format_name: "mp3", duration: "10.0", size: "1000" },
    });
    expect(() => mapOutput(audioOnly, TARGET)).toThrowError(
      expect.objectContaining({ context: expect.objectContaining({ reason: "NOT_A_VIDEO" }) }),
    );
  });

  it("ignores cover art: an mp3 with an attached picture is still not a video", () => {
    const coverArt = JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "mjpeg", width: 500, height: 500, disposition: { attached_pic: 1 } },
        { codec_type: "audio", codec_name: "mp3" },
      ],
      format: { format_name: "mp3", duration: "10.0", size: "1000" },
    });
    expect(() => mapOutput(coverArt, TARGET)).toThrowError(
      expect.objectContaining({ context: expect.objectContaining({ reason: "NOT_A_VIDEO" }) }),
    );
  });

  it("refuses to guess a duration when ffprobe reports none", () => {
    const noDuration = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }],
      format: { format_name: "mov,mp4", size: "1000" },
    });
    expect(() => mapOutput(noDuration, TARGET)).toThrowError(
      expect.objectContaining({ context: expect.objectContaining({ reason: "MISSING_DURATION" }) }),
    );
  });

  it("rejects a video stream without a frame size", () => {
    const noSize = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264" }],
      format: { format_name: "mov,mp4", duration: "5.0", size: "1000" },
    });
    expect(() => mapOutput(noSize, TARGET)).toThrowError(
      expect.objectContaining({ context: expect.objectContaining({ reason: "FFPROBE_OUTPUT_INVALID" }) }),
    );
  });
});

describe("mapOutput — real ffprobe fixtures", () => {
  it("maps the 16:9 feed clip", () => {
    expect(mapOutput(JSON.stringify(feedFixture), TARGET)).toEqual({
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1280,
      height: 720,
      durationSec: 5,
      sizeBytes: 122_919,
      fps: 30,
      rotationDegrees: 0,
    });
  });

  it("maps the 9:16 Reels clip and the gate accepts it", () => {
    const spec = mapOutput(JSON.stringify(reelsFixture), TARGET);
    expect(spec).toMatchObject({ width: 1080, height: 1920, durationSec: 10, fps: 30 });
    expect(evaluateVideoSpec(spec, "facebook_reels").ok).toBe(true);
  });

  it("maps the 2s clip and the gate blocks it for Reels only", () => {
    const spec = mapOutput(JSON.stringify(shortFixture), TARGET);
    expect(spec.durationSec).toBe(2);
    expect(evaluateVideoSpec(spec, "facebook_video").ok).toBe(true);
    const reels = evaluateVideoSpec(spec, "facebook_reels");
    expect(reels.ok).toBe(false);
    if (reels.ok) return;
    expect(reels.violations.map((violation) => violation.rule)).toEqual(["DURATION_MIN"]);
  });

  it("falls back to the stat'ed size when format.size is absent", () => {
    const withoutSize = { ...feedFixture, format: { ...feedFixture.format, size: undefined } };
    expect(mapOutput(JSON.stringify(withoutSize), TARGET).sizeBytes).toBe(1234);
  });
});

describe("mapOutput — rotation", () => {
  /**
   * Derived from the real 16:9 fixture by adding the rotation metadata a phone
   * writes: the frames stay 1280x720 but the video DISPLAYS as 720x1280. Without
   * the swap a valid vertical clip would be rejected as "16:9".
   */
  function withRotation(rotation: unknown, via: "side_data" | "tag"): string {
    const [video, ...rest] = feedFixture.streams;
    const rotated =
      via === "side_data"
        ? { ...video, side_data_list: [{ side_data_type: "Display Matrix", rotation }] }
        : { ...video, tags: { rotate: rotation } };
    return JSON.stringify({ ...feedFixture, streams: [rotated, ...rest] });
  }

  it.each([
    ["side_data -90 (what iPhone .mov files carry)", withRotation(-90, "side_data"), 270],
    ["side_data 90", withRotation(90, "side_data"), 90],
    ["side_data 270", withRotation(270, "side_data"), 270],
    ["tag '90'", withRotation("90", "tag"), 90],
  ])("swaps width and height for %s", (_label, stdout, expectedRotation) => {
    const spec = mapOutput(stdout, TARGET);
    expect([spec.width, spec.height]).toEqual([720, 1280]);
    expect(spec.rotationDegrees).toBe(expectedRotation);
  });

  it("does not swap on a 180 degree rotation", () => {
    const spec = mapOutput(withRotation(180, "side_data"), TARGET);
    expect([spec.width, spec.height]).toEqual([1280, 720]);
    expect(spec.rotationDegrees).toBe(180);
  });

  it("ignores a rotation value it cannot use", () => {
    const spec = mapOutput(withRotation("upside-down", "tag"), TARGET);
    expect([spec.width, spec.height]).toEqual([1280, 720]);
    expect(spec.rotationDegrees).toBe(0);
  });
});

describe("mapOutput — frame rate parsing", () => {
  function withRates(avg: string | undefined, r: string | undefined): string {
    const [video, ...rest] = feedFixture.streams;
    return JSON.stringify({
      ...feedFixture,
      streams: [{ ...video, avg_frame_rate: avg, r_frame_rate: r }, ...rest],
    });
  }

  it.each([
    ["30000/1001 -> 29.97", "30000/1001", 29.97],
    ["60/1 -> 60", "60/1", 60],
    ["plain 25 -> 25", "25", 25],
  ])("parses %s", (_label, value, expected) => {
    expect(mapOutput(withRates(value, "0/0"), TARGET).fps).toBe(expected);
  });

  it("falls back to r_frame_rate when avg_frame_rate is 0/0", () => {
    expect(mapOutput(withRates("0/0", "30/1"), TARGET).fps).toBe(30);
  });

  it("returns null (not 0) when neither rate is usable", () => {
    expect(mapOutput(withRates("0/0", "0/0"), TARGET).fps).toBeNull();
  });
});

describe("probeVideo — spawn paths provable without ffmpeg on the host", () => {
  it("rejects a malformed source before spawning anything", async () => {
    const probe = makeFfprobeMediaProbe({ logger: makeLogger() });
    await expect(probe.probeVideo({ kind: "path", path: "  " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "PROBE_SOURCE_INVALID" },
    });
    await expect(probe.probeVideo(undefined as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects an empty byte buffer", async () => {
    const probe = makeFfprobeMediaProbe({ logger: makeLogger() });
    await expect(
      probe.probeVideo({ kind: "bytes", bytes: new Uint8Array(0), fileName: "a.mp4" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "PROBE_SOURCE_EMPTY" } });
  });

  it("maps a missing file to MEDIA_NOT_FOUND", async () => {
    const probe = makeFfprobeMediaProbe({ logger: makeLogger() });
    await expect(
      probe.probeVideo({ kind: "path", path: "/tmp/mysp-does-not-exist-9f1c.mp4" }),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", context: { reason: "PROBE_FILE_MISSING" } });
  });

  it("maps a missing ffprobe binary to a named reason, not a raw ENOENT", async () => {
    const probe = makeFfprobeMediaProbe({
      logger: makeLogger(),
      ffprobePath: "mysp-ffprobe-does-not-exist",
    });
    await expect(
      probe.probeVideo({ kind: "bytes", bytes: new Uint8Array([0, 1, 2, 3]), fileName: "clip.mov" }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      context: { reason: "FFPROBE_NOT_AVAILABLE", ffprobe_path: "mysp-ffprobe-does-not-exist" },
    });
  });
});
