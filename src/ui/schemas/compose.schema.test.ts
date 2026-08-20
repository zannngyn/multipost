import { describe, expect, it } from "vitest";

import {
  CaptionsResponseSchema,
  ComposeResponseSchema,
  ComposeWizardSchema,
  formatCodecs,
  formatDurationSec,
  formatFileSize,
  formatFps,
  formatResolution,
  postFormatForVideo,
} from "./compose.schema";
import { SyncStatusResponseSchema } from "./sync.schema";

/**
 * These schemas are the UI's mirror of core types it may not import (docs/07
 * §2). The tests exist so a drift in the mirror is caught here, not in the
 * browser as an empty screen.
 */

/** The server still echoes `tenantId` in its answer; the UI only reads it. */
const RESPONSE_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const VALID_COMPOSE = {
  tenantId: RESPONSE_TENANT_ID,
  productCode: "MGKVX6310",
  channel: "facebook",
  content: {
    code: "MGKVX6310",
    name: "Giannal",
    description: null,
    category: "Áo",
    season: "Hè",
  },
  inventory: {
    status: "in_stock",
    blocked: false,
    reason: null,
    stock: 104,
    operatorMessage: null,
  },
  media: [
    {
      driveFileId: "1abc",
      fileName: "MGKVX6310 TRẮNG 3.jpg",
      color: "TRẮNG",
      sequence: 3,
      kind: "image",
      warnings: [],
      needsReview: false,
    },
  ],
  availableColors: ["TRẮNG"],
  warnings: [],
  video: null,
};

const VALID_SPEC = {
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1080,
  height: 1920,
  durationSec: 12.5,
  sizeBytes: 24_000_000,
  fps: 30,
};

describe("ComposeWizardSchema", () => {
  const base = {
    productCode: "MGKVX6310",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: {},
  };

  it("rejects a file source the server does not know", () => {
    expect(ComposeWizardSchema.safeParse({ ...base, source: "dropbox" }).success).toBe(false);
  });

  it("accepts the upload mode", () => {
    expect(ComposeWizardSchema.safeParse({ ...base, source: "upload" }).success).toBe(true);
  });

  it("rejects a media kind the server does not know", () => {
    expect(ComposeWizardSchema.safeParse({ ...base, mediaKind: "gif" }).success).toBe(false);
  });

  it("rejects a video target spelled differently from the server's", () => {
    // "reels" is the POST FORMAT, not the video target — mixing them up would
    // send a value composePost refuses.
    expect(ComposeWizardSchema.safeParse({ ...base, videoTarget: "reels" }).success).toBe(false);
  });

  it("ignores a tenant id an old draft may still carry (M1.4)", () => {
    // The wizard has no company field any more: the session decides. A stored
    // draft written before M1.4 must still load instead of failing the parse.
    const result = ComposeWizardSchema.safeParse({ ...base, tenantId: "demo" });
    expect(result.success).toBe(true);
    expect(result.success && "tenantId" in result.data).toBe(false);
  });

  it("rejects an empty product code", () => {
    expect(ComposeWizardSchema.safeParse({ ...base, productCode: "   " }).success).toBe(false);
  });

  it("rejects a product code with unexpected characters", () => {
    expect(ComposeWizardSchema.safeParse({ ...base, productCode: "MG/VX 6310" }).success).toBe(
      false,
    );
  });

  it("accepts an absent colour and trims the typed one", () => {
    const result = ComposeWizardSchema.safeParse({ ...base, color: "  TRẮNG " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.color).toBe("TRẮNG");
  });
});

describe("ComposeResponseSchema", () => {
  it("accepts a composed post", () => {
    expect(ComposeResponseSchema.safeParse(VALID_COMPOSE).success).toBe(true);
  });

  it("refuses a post with no media — an album of zero photos is never valid", () => {
    expect(ComposeResponseSchema.safeParse({ ...VALID_COMPOSE, media: [] }).success).toBe(false);
  });

  it("accepts a null inventory (product not evaluated)", () => {
    expect(ComposeResponseSchema.safeParse({ ...VALID_COMPOSE, inventory: null }).success).toBe(
      true,
    );
  });

  it("refuses a video block whose target is not one the server sends", () => {
    const result = ComposeResponseSchema.safeParse({
      ...VALID_COMPOSE,
      video: { target: "tiktok", spec: null },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a video post whose spec could not be probed (worker will check)", () => {
    const result = ComposeResponseSchema.safeParse({
      ...VALID_COMPOSE,
      video: { target: "facebook_reels", spec: null },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.video?.spec).toBeNull();
  });

  it("accepts a probed video spec", () => {
    const result = ComposeResponseSchema.safeParse({
      ...VALID_COMPOSE,
      video: { target: "facebook_video", spec: VALID_SPEC },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.video?.spec?.width).toBe(1080);
  });

  it("drops fields outside the caption whitelist instead of exposing them", () => {
    const result = ComposeResponseSchema.safeParse({
      ...VALID_COMPOSE,
      content: { ...VALID_COMPOSE.content, price: "550000", stock: "104" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).not.toHaveProperty("price");
      expect(result.data.content).not.toHaveProperty("stock");
    }
  });
});

describe("postFormatForVideo", () => {
  it("returns image_post when nothing was composed as video", () => {
    expect(postFormatForVideo(null)).toBe("image_post");
  });

  it("maps the two video targets onto the two video formats", () => {
    expect(postFormatForVideo({ target: "facebook_video" })).toBe("video_post");
    expect(postFormatForVideo({ target: "facebook_reels" })).toBe("reels");
  });
});

describe("video spec formatting", () => {
  it("does not invent numbers for an unreadable spec", () => {
    expect(formatDurationSec(Number.NaN)).toBe("—");
    expect(formatFileSize(-1)).toBe("—");
    expect(formatResolution(0, 1920)).toBe("—");
    expect(formatFps(null)).toBe("không đọc được");
  });

  it("reads the numbers the way an operator says them", () => {
    expect(formatDurationSec(12.5)).toBe("12,5 giây");
    expect(formatDurationSec(150)).toBe("2,5 phút");
    expect(formatFileSize(24_000_000)).toBe("24,0 MB");
    expect(formatFileSize(1_200_000_000)).toBe("1,2 GB");
    expect(formatResolution(1080, 1920)).toBe("1080x1920 (9:16)");
    expect(formatFps(30)).toBe("30 fps");
  });

  it("says out loud that a clip has no sound", () => {
    expect(formatCodecs("h264", null)).toBe("H264, không có tiếng");
    expect(formatCodecs("h264", "aac")).toBe("H264 + AAC");
  });
});

describe("CaptionsResponseSchema", () => {
  it("accepts a run where one channel succeeded and another failed", () => {
    const result = CaptionsResponseSchema.safeParse({
      generated: [
        {
          channelId: "facebook",
          platform: "facebook",
          text: "Giannal – ĐẸP",
          hashtags: ["#mysp"],
          model: "gemini",
          provider: "google",
        },
      ],
      failed: [
        { channelId: "tiktok", platform: "tiktok", code: "MODEL_NOT_CONFIGURED", reason: "Chưa cấu hình." },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a generated caption with empty text", () => {
    const result = CaptionsResponseSchema.safeParse({
      generated: [
        {
          channelId: "facebook",
          platform: "facebook",
          text: "",
          hashtags: [],
          model: "m",
          provider: "p",
        },
      ],
      failed: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("SyncStatusResponseSchema", () => {
  it("treats 'never synced' as a valid answer, not an error", () => {
    const result = SyncStatusResponseSchema.safeParse({
      state: "never_synced",
      tenantId: RESPONSE_TENANT_ID,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a finished run and keeps the truncation flag", () => {
    const result = SyncStatusResponseSchema.safeParse({
      state: "has_run",
      run: {
        tenantId: RESPONSE_TENANT_ID,
        syncRunId: "run-1",
        status: "partial",
        startedAt: "2026-08-12T10:00:00.000Z",
        finishedAt: "2026-08-12T10:02:00.000Z",
        counts: {
          driveFilesSeen: 5500,
          mediaParsed: 5000,
          mediaRejected: 500,
          mediaDuplicatesDropped: 10,
          mediaNeedingReview: 20,
          sheetRowsSeen: 900,
          productsParsed: 880,
          sheetRowsRejected: 20,
          productsWithConflict: 1,
          productsWithoutMedia: 30,
          mediaWithoutProduct: 40,
          productsWritten: 880,
          mediaWritten: 5000,
          productsDeleted: 0,
          mediaDeleted: 0,
          issuesTotal: 3491,
          issuesTruncated: true,
        },
        issues: [
          {
            errorCode: "FILE_NAME_INVALID",
            reason: "NO_PRODUCT_CODE",
            ref: "abc.jpg",
            detail: "Tên file không chứa mã sản phẩm nào.",
          },
        ],
        // Exact counts: 3.491 detected, 200 stored, 3 kept as examples.
        issueGroups: [
          {
            errorCode: "FILE_NAME_INVALID",
            count: 3491,
            examples: [
              {
                errorCode: "FILE_NAME_INVALID",
                reason: "NO_PRODUCT_CODE",
                ref: "abc.jpg",
                detail: "Tên file không chứa mã sản phẩm nào.",
              },
            ],
          },
        ],
        errorCode: null,
        errorMessage: null,
        recentRuns: [
          {
            syncRunId: "run-1",
            status: "partial",
            startedAt: "2026-08-12T10:00:00.000Z",
            finishedAt: "2026-08-12T10:02:00.000Z",
            issuesTotal: 3491,
            errorCode: null,
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "has_run") {
      expect(result.data.run.counts?.issuesTruncated).toBe(true);
      expect(result.data.run.counts?.issuesTotal).toBe(3491);
      // The group count survives the cap on `issues[]` — that is its whole job.
      expect(result.data.run.issueGroups?.[0]?.count).toBe(3491);
    }
  });

  it("accepts a still-running run with no counts yet", () => {
    const result = SyncStatusResponseSchema.safeParse({
      state: "has_run",
      run: {
        tenantId: RESPONSE_TENANT_ID,
        syncRunId: "run-2",
        status: "running",
        startedAt: "2026-08-12T10:00:00.000Z",
        finishedAt: null,
        counts: null,
        issues: [],
        // Nothing has been grouped yet, and the history shows the run in flight.
        issueGroups: null,
        errorCode: null,
        errorMessage: null,
        recentRuns: [
          {
            syncRunId: "run-2",
            status: "running",
            startedAt: "2026-08-12T10:00:00.000Z",
            finishedAt: null,
            issuesTotal: null,
            errorCode: null,
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "has_run") {
      expect(result.data.run.issueGroups).toBeNull();
      expect(result.data.run.recentRuns[0]?.issuesTotal).toBeNull();
    }
  });

  it("rejects an unknown state instead of rendering nothing", () => {
    expect(SyncStatusResponseSchema.safeParse({ state: "maybe" }).success).toBe(false);
  });
});
