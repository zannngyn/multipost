import { describe, expect, it } from "vitest";

import {
  evaluateVideoSpec,
  isVideoTarget,
  summarizeViolations,
  FACEBOOK_REELS_LIMITS,
  FACEBOOK_VIDEO_LIMITS,
  type VideoSpec,
  type VideoSpecRule,
} from "../video-spec";

/**
 * Decision table of the video gate. The three "known good" shapes come from
 * clips ffprobe really measured (src/adapters/media/__fixtures__, produced by
 * scripts/video-probe-smoke.ts inside a container with ffmpeg); the failing
 * variants are those shapes with one field pushed over a documented limit.
 */

/** 1280x720 h264/aac 5s — the feed clip of the smoke run. */
const FEED_CLIP: VideoSpec = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1280,
  height: 720,
  durationSec: 5,
  sizeBytes: 122_919,
  fps: 30,
  rotationDegrees: 0,
};

/** 1080x1920 h264/aac 10s — the Reels clip of the smoke run. */
const REELS_CLIP: VideoSpec = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1080,
  height: 1920,
  durationSec: 10,
  sizeBytes: 298_056,
  fps: 30,
  rotationDegrees: 0,
};

function rulesOf(spec: VideoSpec, target: Parameters<typeof evaluateVideoSpec>[1]): VideoSpecRule[] {
  const verdict = evaluateVideoSpec(spec, target);
  return verdict.ok ? [] : verdict.violations.map((violation) => violation.rule).sort();
}

describe("evaluateVideoSpec — edge cases first", () => {
  it("throws INVALID_INPUT on an unknown target", () => {
    expect(() => evaluateVideoSpec(FEED_CLIP, "tiktok_video" as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it.each([
    ["missing container", { container: "" }],
    ["missing video codec", { videoCodec: "   " }],
    ["zero width", { width: 0 }],
    ["NaN height", { height: Number.NaN }],
    ["zero duration", { durationSec: 0 }],
    ["negative duration", { durationSec: -3 }],
    ["missing size", { sizeBytes: 0 }],
    ["infinite size", { sizeBytes: Number.POSITIVE_INFINITY }],
  ])("blocks with SPEC_UNREADABLE when the probe result is unusable: %s", (_label, patch) => {
    const verdict = evaluateVideoSpec({ ...FEED_CLIP, ...patch } as VideoSpec, "facebook_video");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations.map((violation) => violation.rule)).toEqual(["SPEC_UNREADABLE"]);
    expect(verdict.violations[0].userMessage).toMatch(/Không đọc được thông số video/);
  });

  it("survives a spec object that is missing fields entirely", () => {
    const verdict = evaluateVideoSpec({} as VideoSpec, "facebook_reels");
    expect(verdict.ok).toBe(false);
  });

  it("reports EVERY broken rule, not only the first", () => {
    const broken: VideoSpec = {
      ...REELS_CLIP,
      container: "avi",
      videoCodec: "mpeg4",
      durationSec: 200,
      width: 400,
      height: 300,
      fps: 12,
    };
    expect(rulesOf(broken, "facebook_reels")).toEqual([
      "ASPECT_RATIO",
      "CONTAINER",
      "DURATION_MAX",
      "FPS_MIN",
      "RESOLUTION_MIN",
      "VIDEO_CODEC",
    ]);
  });
});

describe("evaluateVideoSpec — facebook_video (feed post)", () => {
  it("passes the 16:9 clip measured by ffprobe", () => {
    const verdict = evaluateVideoSpec(FEED_CLIP, "facebook_video");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warnings).toEqual([]);
  });

  it("passes a 9:16 clip too — the feed accepts the whole 9:16..16:9 range", () => {
    expect(evaluateVideoSpec(REELS_CLIP, "facebook_video").ok).toBe(true);
  });

  it.each([
    ["1:1 square", { width: 1080, height: 1080 }],
    ["4:5 portrait", { width: 1080, height: 1350 }],
  ])("accepts %s, which sits inside the range", (_label, size) => {
    expect(rulesOf({ ...FEED_CLIP, ...size }, "facebook_video")).toEqual([]);
  });

  it("blocks a 2.35:1 cinema crop (wider than 16:9)", () => {
    expect(rulesOf({ ...FEED_CLIP, width: 2350, height: 1000 }, "facebook_video")).toEqual([
      "ASPECT_RATIO",
    ]);
  });

  it("blocks a file over the 10GB ceiling and names both numbers", () => {
    const verdict = evaluateVideoSpec(
      { ...FEED_CLIP, sizeBytes: FACEBOOK_VIDEO_LIMITS.maxSizeBytes + 1 },
      "facebook_video",
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations[0]).toMatchObject({ rule: "FILE_SIZE_MAX" });
    expect(verdict.violations[0].userMessage).toContain("10,0 GB");
  });

  it("blocks a clip longer than 240 minutes", () => {
    expect(
      rulesOf({ ...FEED_CLIP, durationSec: FACEBOOK_VIDEO_LIMITS.maxDurationSec + 1 }, "facebook_video"),
    ).toEqual(["DURATION_MAX"]);
  });

  it("blocks a 0.5s clip (below the 1s floor)", () => {
    expect(rulesOf({ ...FEED_CLIP, durationSec: 0.5 }, "facebook_video")).toEqual(["DURATION_MIN"]);
  });

  it("blocks a 120fps clip but tolerates 60.02fps rounding", () => {
    expect(rulesOf({ ...FEED_CLIP, fps: 120 }, "facebook_video")).toEqual(["FPS_MAX"]);
    expect(rulesOf({ ...FEED_CLIP, fps: 60.02 }, "facebook_video")).toEqual([]);
  });

  it("blocks an unsupported container and codec", () => {
    expect(rulesOf({ ...FEED_CLIP, container: "matroska,webm" }, "facebook_video")).toEqual([
      "CONTAINER",
    ]);
    expect(rulesOf({ ...FEED_CLIP, videoCodec: "vp9" }, "facebook_video")).toEqual(["VIDEO_CODEC"]);
  });

  it("accepts hevc, which Meta supports alongside h264", () => {
    expect(rulesOf({ ...FEED_CLIP, videoCodec: "hevc" }, "facebook_video")).toEqual([]);
  });
});

describe("evaluateVideoSpec — facebook_reels", () => {
  it("passes the 9:16 clip measured by ffprobe", () => {
    const verdict = evaluateVideoSpec(REELS_CLIP, "facebook_reels");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warnings).toEqual([]);
  });

  it("blocks the landscape feed clip on both resolution and aspect ratio", () => {
    expect(rulesOf(FEED_CLIP, "facebook_reels")).toEqual(["ASPECT_RATIO", "RESOLUTION_MIN"]);
  });

  it("blocks a 2s clip (Reels floor is 3s) and says so in Vietnamese", () => {
    const verdict = evaluateVideoSpec({ ...REELS_CLIP, durationSec: 2 }, "facebook_reels");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatchObject({
      rule: "DURATION_MIN",
      actual: "2,0 giây",
      limit: "tối thiểu 3,0 giây",
    });
    expect(verdict.violations[0].userMessage).toBe(
      "Video dài 2,0 giây — Reels Facebook yêu cầu tối thiểu 3,0 giây",
    );
  });

  it("blocks a clip longer than 90s", () => {
    expect(
      rulesOf({ ...REELS_CLIP, durationSec: FACEBOOK_REELS_LIMITS.maxDurationSec + 0.5 }, "facebook_reels"),
    ).toEqual(["DURATION_MAX"]);
  });

  it("blocks 540x960 minus one pixel, accepts exactly 540x960", () => {
    expect(rulesOf({ ...REELS_CLIP, width: 539, height: 958 }, "facebook_reels")).toEqual([
      "RESOLUTION_MIN",
    ]);
    const atFloor = evaluateVideoSpec({ ...REELS_CLIP, width: 540, height: 960 }, "facebook_reels");
    expect(atFloor.ok).toBe(true);
    if (!atFloor.ok) return;
    // Allowed, but the operator is told it is below the recommended 1080p.
    expect(atFloor.warnings.join(" ")).toMatch(/khuyến nghị 1080p/);
  });

  it("blocks a file over the 1GB Reels ceiling that a feed video would accept", () => {
    const big = { ...REELS_CLIP, sizeBytes: 2 * 1_000_000_000 };
    expect(rulesOf(big, "facebook_reels")).toEqual(["FILE_SIZE_MAX"]);
    expect(rulesOf(big, "facebook_video")).toEqual([]);
  });

  it("blocks a 15fps clip (Reels floor is 24fps)", () => {
    expect(rulesOf({ ...REELS_CLIP, fps: 15 }, "facebook_reels")).toEqual(["FPS_MIN"]);
  });

  it("does not block when the frame rate could not be read — it warns", () => {
    const verdict = evaluateVideoSpec({ ...REELS_CLIP, fps: null }, "facebook_reels");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warnings.join(" ")).toMatch(/tốc độ khung hình/);
  });

  it("tolerates a 1079x1920 export inside the 1% aspect allowance", () => {
    expect(rulesOf({ ...REELS_CLIP, width: 1079 }, "facebook_reels")).toEqual([]);
  });

  it("blocks 1080x1350 (4:5), which is portrait but not 9:16", () => {
    expect(rulesOf({ ...REELS_CLIP, height: 1350 }, "facebook_reels")).toEqual(["ASPECT_RATIO"]);
  });
});

describe("evaluateVideoSpec — audio is a warning, never a block", () => {
  it("warns on a silent clip", () => {
    const verdict = evaluateVideoSpec({ ...REELS_CLIP, audioCodec: null }, "facebook_reels");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warnings.join(" ")).toMatch(/không có tiếng/);
  });

  it("warns on an exotic audio codec instead of refusing the post", () => {
    const verdict = evaluateVideoSpec({ ...REELS_CLIP, audioCodec: "opus" }, "facebook_reels");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warnings.join(" ")).toMatch(/opus/);
  });
});

describe("helpers", () => {
  it("isVideoTarget rejects anything that is not a known target", () => {
    expect(isVideoTarget("facebook_reels")).toBe(true);
    expect(isVideoTarget("instagram_reels")).toBe(false);
    expect(isVideoTarget(undefined)).toBe(false);
  });

  it("summarizeViolations joins the operator messages", () => {
    const verdict = evaluateVideoSpec({ ...FEED_CLIP, durationSec: 0.2 }, "facebook_reels");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    const summary = summarizeViolations(verdict.violations);
    expect(summary.split(";").length).toBe(verdict.violations.length);
  });
});
