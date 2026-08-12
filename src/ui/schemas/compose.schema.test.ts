import { describe, expect, it } from "vitest";

import {
  CaptionsResponseSchema,
  ComposeResponseSchema,
  ComposeWizardSchema,
} from "./compose.schema";
import { SyncStatusResponseSchema } from "./sync.schema";
import { DEMO_TENANT_ID } from "./tenant-health.schema";

/**
 * These schemas are the UI's mirror of core types it may not import (docs/07
 * §2). The tests exist so a drift in the mirror is caught here, not in the
 * browser as an empty screen.
 */

const VALID_COMPOSE = {
  tenantId: DEMO_TENANT_ID,
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
};

describe("ComposeWizardSchema", () => {
  const base = { tenantId: DEMO_TENANT_ID, productCode: "MGKVX6310", captions: {} };

  it("rejects a tenant id that is not a UUID", () => {
    const result = ComposeWizardSchema.safeParse({ ...base, tenantId: "demo" });
    expect(result.success).toBe(false);
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
      tenantId: DEMO_TENANT_ID,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a finished run and keeps the truncation flag", () => {
    const result = SyncStatusResponseSchema.safeParse({
      state: "has_run",
      run: {
        tenantId: DEMO_TENANT_ID,
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
          { errorCode: "FILE_NAME_INVALID", reason: "NO_PRODUCT_CODE", ref: "abc.jpg", detail: "x" },
        ],
        errorCode: null,
        errorMessage: null,
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "has_run") {
      expect(result.data.run.counts?.issuesTruncated).toBe(true);
      expect(result.data.run.counts?.issuesTotal).toBe(3491);
    }
  });

  it("accepts a still-running run with no counts yet", () => {
    const result = SyncStatusResponseSchema.safeParse({
      state: "has_run",
      run: {
        tenantId: DEMO_TENANT_ID,
        syncRunId: "run-2",
        status: "running",
        startedAt: "2026-08-12T10:00:00.000Z",
        finishedAt: null,
        counts: null,
        issues: [],
        errorCode: null,
        errorMessage: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown state instead of rendering nothing", () => {
    expect(SyncStatusResponseSchema.safeParse({ state: "maybe" }).success).toBe(false);
  });
});
