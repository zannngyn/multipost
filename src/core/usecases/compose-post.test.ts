import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { MediaAsset, Product } from "@/core/domain/product";
import type { VideoSpec } from "@/core/domain/video-spec";
import type { Logger } from "@/core/ports/infra";
import type { VideoAssetProbe } from "@/core/ports/media-probe";
import type { MediaRepo, ProductRepo } from "@/core/ports/product-repo";

import { makeComposePost, VIDEO_NOT_CHECKED_WARNING } from "./compose-post";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const CHANNEL = "fb-page-1";

/** E9 additions to MediaRepo; composing never calls them. */
const UPLOAD_STUBS = {
  registerUpload: async () => {},
  listOrphanedUploads: async () => [],
  listUnreferencedUploadsForCode: async () => [],
  deleteUploads: async () => 0,
  // Sync-only reader; composing a post never counts rows.
  countDriveAssets: async () => 0,
} satisfies Pick<
  MediaRepo,
  | "registerUpload"
  | "listOrphanedUploads"
  | "listUnreferencedUploadsForCode"
  | "deleteUploads"
  | "countDriveAssets"
>;

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

function product(overrides: Partial<Product> = {}): Product {
  return {
    content: {
      code: "MGKVX6310",
      name: "Giannal",
      description: "Váy dáng xoè",
      category: "Váy",
      season: "Xuân hè 2026",
    },
    operational: { stockRaw: "104", noteRaw: "Không nhận sx 1c", colorsRaw: "KEM, HỒNG" },
    hasConflict: false,
    sourceRows: [2],
    ...overrides,
  };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    driveFileId: `id-${overrides.sequence ?? 0}-${overrides.color ?? "KEM"}`,
    origin: "drive",
    storageKey: null,
    fileName: `MGKVX6310-KEM (${overrides.sequence ?? 0}).jpg`,
    productCode: "MGKVX6310",
    color: "KEM",
    colorRaw: "KEM",
    sequence: 0,
    kind: "image",
    variants: { aiGenerated: false, realPhoto: false, backView: false },
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00.000Z",
    warnings: [],
    needsReview: false,
    ...overrides,
  };
}

function harness(options: { product?: Product | null; media?: MediaAsset[] } = {}) {
  const products: ProductRepo = {
    findByCode: async () => (options.product === undefined ? product() : options.product),
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => 0,
  };
  const media: MediaRepo = {
    listByProductCode: async () => options.media ?? [],
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    ...UPLOAD_STUBS,
  };
  return makeComposePost({ products, media, logger: makeLogger() });
}

const numbered = (numbers: number[], color = "KEM") =>
  numbers.map((sequence) =>
    asset({ sequence, color, colorRaw: color, fileName: `MGKVX6310-${color} (${sequence}).jpg` }),
  );

describe("composePost — edge cases first", () => {
  it.each([
    ["bad tenant", { tenantId: testTenantId("nope"), productCode: "MGKVX6310", channel: CHANNEL }],
    ["empty code", { tenantId: TENANT, productCode: "  ", channel: CHANNEL }],
    ["empty channel", { tenantId: TENANT, productCode: "MGKVX6310", channel: "" }],
  ])("throws INVALID_INPUT on %s", async (_label, input) => {
    await expect(harness()(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws INVALID_INPUT on a non-integer sequence list", async () => {
    await expect(
      harness()({
        tenantId: TENANT,
        productCode: "MGKVX6310",
        channel: CHANNEL,
        sequences: [1, -3],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns a blocked result (not a throw) when the product is unknown", async () => {
    const result = await harness({ product: null })({
      tenantId: TENANT,
      productCode: "MG0XX0000",
      channel: CHANNEL,
    });
    expect(result.blocked).toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    expect(result.content).toBeNull();
  });

  it("blocks a sold-out code BEFORE looking at media (business rule 1)", async () => {
    const listByProductCode = vi.fn(async () => []);
    const products: ProductRepo = {
      findByCode: async () =>
        product({ operational: { stockRaw: "0", noteRaw: "HẾT HÀNG", colorsRaw: "" } }),
      upsertMany: async () => 0,
      deleteStale: async () => 0,
      countAll: async () => 0,
    };
    const media: MediaRepo = {
      listByProductCode,
      upsertMany: async () => 0,
      deleteStale: async () => 0,
      ...UPLOAD_STUBS,
    };
    const compose = makeComposePost({ products, media, logger: makeLogger() });

    const result = await compose({ tenantId: TENANT, productCode: "MR0AC6080", channel: CHANNEL });

    expect(result.blocked).toMatchObject({ code: "OUT_OF_STOCK", reason: "NOTE_SOLD_OUT" });
    expect(result.content).toBeNull();
    expect(result.media).toEqual([]);
    expect(listByProductCode).not.toHaveBeenCalled();
  });

  it("blocks a code whose sheet rows conflict", async () => {
    const result = await harness({ product: product({ hasConflict: true }) })({
      tenantId: TENANT,
      productCode: "MGKSQ6031",
      channel: CHANNEL,
    });
    expect(result.blocked).toMatchObject({ code: "OUT_OF_STOCK", reason: "SHEET_ROW_CONFLICT" });
  });

  it("blocks when the code has no media at all", async () => {
    const result = await harness({ media: [] })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(result.blocked).toMatchObject({ code: "MEDIA_NOT_FOUND", reason: "NO_MEDIA_FOR_CODE" });
  });

  it("blocks when the requested colour has no photos, listing what exists", async () => {
    const result = await harness({ media: numbered([1, 2, 3]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      colors: ["TÍM"],
    });
    expect(result.blocked).toMatchObject({ code: "MEDIA_NOT_FOUND", reason: "NO_MEDIA_FOR_COLOR" });
    expect(result.blocked?.userMessage).toContain("KEM");
  });

  it("blocks and names the missing numbers (PENDING C5)", async () => {
    const result = await harness({ media: numbered([3, 7]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      sequences: [3, 7, 99],
    });
    expect(result.blocked).toMatchObject({
      code: "MEDIA_NOT_FOUND",
      reason: "SEQUENCES_NOT_FOUND",
    });
    expect(result.blocked?.userMessage).toContain("99");
  });

  it("blocks when only videos exist but images were asked for", async () => {
    const result = await harness({ media: [asset({ kind: "video", sequence: 1 })] })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(result.blocked).toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });

  it("warns instead of blocking when a code has fewer than 5 photos", async () => {
    const result = await harness({ media: numbered([1, 2]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(result.blocked).toBeNull();
    expect(result.media).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.includes("tối thiểu"))).toBe(true);
  });
});

describe("composePost — media selection (brief section 4.2)", () => {
  it("takes the exact numbers, in the typed order", async () => {
    const result = await harness({ media: numbered([3, 7, 12, 18, 25]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      sequences: [25, 3, 7],
    });
    expect(result.media.map((item) => item.sequence)).toEqual([25, 3, 7]);
  });

  it("puts a single typed number first, then the rest ascending, max 10", async () => {
    const result = await harness({ media: numbered([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 25]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      sequences: [25],
    });
    expect(result.media).toHaveLength(10);
    expect(result.media.map((item) => item.sequence)).toEqual([25, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("handles a single number that is the largest one (PENDING C2)", async () => {
    const result = await harness({ media: numbered([50, 51, 64]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      sequences: [64],
    });
    expect(result.media.map((item) => item.sequence)).toEqual([64, 50, 51]);
  });

  it("takes the first 10 ascending when nothing is typed, numbers not starting at 1", async () => {
    const result = await harness({
      media: numbered([50, 51, 52, 53, 54, 56, 60, 61, 62, 63, 64]),
    })({ tenantId: TENANT, productCode: "MGKVX6310", channel: CHANNEL });
    expect(result.media).toHaveLength(10);
    expect(result.media[0].sequence).toBe(50);
  });

  it("keeps unnumbered files usable, sorted after the numbered ones", async () => {
    const media = [
      ...numbered([2]),
      asset({ sequence: null, fileName: "MGKVX6310-KEM-AI", needsReview: true }),
    ];
    const result = await harness({ media })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(result.media.map((item) => item.sequence)).toEqual([2, null]);
    expect(result.warnings.some((warning) => warning.includes("không đúng chuẩn"))).toBe(true);
  });

  it("never uses a back-view photo as the cover (PENDING docs/05 Q3)", async () => {
    const media = [
      asset({ sequence: 1, variants: { aiGenerated: false, realPhoto: false, backView: true } }),
      asset({ sequence: 2 }),
    ];
    const result = await harness({ media })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(result.media[0].sequence).toBe(2);
    expect(result.media).toHaveLength(2);
  });

  it("does not mix colours when none was requested (PENDING C3/C4)", async () => {
    const media = [...numbered([1, 2], "KEM"), ...numbered([3, 4, 5], "HỒNG")];
    const result = await harness({ media })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(new Set(result.media.map((item) => item.color))).toEqual(new Set(["HỒNG"]));
    expect(result.warnings.some((warning) => warning.includes("nhiều màu"))).toBe(true);
    expect(result.availableColors).toEqual(["HỒNG", "KEM"]);
  });

  it("breaks a colour tie deterministically", async () => {
    const media = [...numbered([1, 2], "KEM"), ...numbered([3, 4], "HỒNG")];
    const first = await harness({ media })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    const second = await harness({ media: [...media].reverse() })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });
    expect(first.media.map((item) => item.driveFileId)).toEqual(
      second.media.map((item) => item.driveFileId),
    );
  });

  it("filters by colour whatever the spelling, and stays inside it (PENDING C3)", async () => {
    const media = [...numbered([1, 2], "KEM"), ...numbered([3, 4], "NÂU")];
    const result = await harness({ media })({
      tenantId: TENANT,
      productCode: "MG0VS6111",
      channel: CHANNEL,
      colors: ["nau"],
    });
    expect(result.media.map((item) => item.sequence)).toEqual([3, 4]);
    expect(result.availableColors).toEqual(["KEM", "NÂU"]);
  });
});

describe("composePost — happy path", () => {
  it("returns only whitelisted content plus the album", async () => {
    const result = await harness({ media: numbered([1, 2, 3, 4, 5]) })({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
    });

    expect(result.blocked).toBeNull();
    expect(Object.keys(result.content ?? {}).sort()).toEqual([
      "category",
      "code",
      "description",
      "name",
      "season",
    ]);
    expect(JSON.stringify(result.content)).not.toContain("104");
    expect(result.inventory).toMatchObject({ status: "in_stock", stock: 104 });
  });

  it("carries the low-stock warning for the operator, never in the content", async () => {
    const lowStock = product({
      operational: { stockRaw: "3", noteRaw: "Không nhận sx 1c", colorsRaw: "KEM" },
    });
    const result = await harness({ product: lowStock, media: numbered([1, 2, 3, 4, 5]) })({
      tenantId: TENANT,
      productCode: "MG0VS6111",
      channel: CHANNEL,
    });

    expect(result.inventory).toMatchObject({ status: "low_stock", stock: 3 });
    expect(result.warnings[0]).toBe("Tồn thấp 3c — Không nhận sx 1c");
    expect(JSON.stringify(result.content)).not.toContain("Tồn thấp");
  });
});

/**
 * E3 Phase 2 — video spec gate (brief section 5, docs/02 section 5.1 step 4).
 * The specs below mirror the clips ffprobe really measured in the smoke run
 * (src/adapters/media/__fixtures__).
 */

const REELS_SPEC: VideoSpec = {
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

const clip = (sequence: number, extension = "mp4") =>
  asset({
    driveFileId: `video-${sequence}`,
    fileName: `MG0AC6017-KEM (${sequence}).${extension}`,
    kind: "video",
    mimeType: `video/${extension}`,
    sequence,
    sizeBytes: 298_056,
  });

function videoHarness(options: {
  media?: MediaAsset[];
  spec?: VideoSpec;
  probeError?: unknown;
  probe?: VideoAssetProbe;
}) {
  const probeAsset = vi.fn(async () => {
    if (options.probeError !== undefined) throw options.probeError;
    return options.spec ?? REELS_SPEC;
  });
  const products: ProductRepo = {
    findByCode: async () => product(),
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => 0,
  };
  const media: MediaRepo = {
    listByProductCode: async () => options.media ?? [clip(1)],
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    ...UPLOAD_STUBS,
  };
  const videoProbe = options.probe ?? { probeAsset };
  return {
    compose: makeComposePost({ products, media, logger: makeLogger(), videoProbe }),
    probeAsset,
  };
}

describe("composePost — video spec gate", () => {
  it("throws INVALID_INPUT on an unknown video target", async () => {
    await expect(
      videoHarness({}).compose({
        tenantId: TENANT,
        productCode: "MG0AC6017",
        channel: CHANNEL,
        mediaKind: "video",
        videoTarget: "instagram_reels" as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("never probes a sold-out code — the stock gate still comes first", async () => {
    const products: ProductRepo = {
      findByCode: async () => product({ operational: { stockRaw: "0", noteRaw: "", colorsRaw: "" } }),
      upsertMany: async () => 0,
      deleteStale: async () => 0,
      countAll: async () => 0,
    };
    const probeAsset = vi.fn(async () => REELS_SPEC);
    const compose = makeComposePost({
      products,
      media: {
        listByProductCode: async () => [clip(1)],
        upsertMany: async () => 0,
        deleteStale: async () => 0,
        ...UPLOAD_STUBS,
      },
      logger: makeLogger(),
      videoProbe: { probeAsset },
    });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });

    expect(result.blocked).toMatchObject({ code: "OUT_OF_STOCK" });
    expect(probeAsset).not.toHaveBeenCalled();
  });

  it("passes a 9:16 clip for Reels and reports the probed spec", async () => {
    const { compose, probeAsset } = videoHarness({});
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
      videoTarget: "facebook_reels",
    });

    expect(result.blocked).toBeNull();
    expect(result.media).toHaveLength(1);
    expect(result.video).toEqual({ target: "facebook_reels", spec: REELS_SPEC });
    expect(probeAsset).toHaveBeenCalledTimes(1);
  });

  it("blocks a 2s clip for Reels with the violation spelled out in Vietnamese", async () => {
    const { compose } = videoHarness({ spec: { ...REELS_SPEC, durationSec: 2 } });
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
      videoTarget: "facebook_reels",
    });

    expect(result.blocked).toMatchObject({ code: "INVALID_INPUT", reason: "VIDEO_SPEC_INVALID" });
    expect(result.blocked?.userMessage).toContain("MG0AC6017-KEM (1).mp4");
    expect(result.blocked?.userMessage).toContain("tối thiểu 3,0 giây");
    expect(result.content).toBeNull();
    expect(result.video?.spec).toMatchObject({ durationSec: 2 });
  });

  it("accepts the same 2s clip as a plain feed video (target decides)", async () => {
    const { compose } = videoHarness({ spec: { ...REELS_SPEC, durationSec: 2 } });
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
      videoTarget: "facebook_video",
    });
    expect(result.blocked).toBeNull();
  });

  it("defaults to a feed video when no target is given", async () => {
    const { compose } = videoHarness({});
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });
    expect(result.video?.target).toBe("facebook_video");
  });

  it("keeps ONE clip when the code has several, and says which one went out", async () => {
    const { compose, probeAsset } = videoHarness({ media: [clip(3, "mov"), clip(1), clip(2)] });
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });

    expect(result.media.map((item) => item.fileName)).toEqual(["MG0AC6017-KEM (1).mp4"]);
    expect(result.warnings.join(" ")).toContain("chỉ dùng \"MG0AC6017-KEM (1).mp4\"");
    expect(probeAsset).toHaveBeenCalledTimes(1);
  });

  it("does not warn about the 5-photo minimum on a video post", async () => {
    const { compose } = videoHarness({});
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });
    expect(result.warnings.join(" ")).not.toContain("ít hơn mức tối thiểu");
  });

  it("blocks when the file cannot be probed (corrupt / not a video)", async () => {
    const { compose } = videoHarness({
      probeError: new AppError("INVALID_INPUT", {
        message: "ffprobe exited with code 1",
        userMessage: "File này không phải video hợp lệ hoặc đã hỏng.",
        context: { reason: "FFPROBE_EXIT_NONZERO", exit_code: 1 },
      }),
    });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });

    expect(result.blocked).toMatchObject({
      code: "INVALID_INPUT",
      reason: "FFPROBE_EXIT_NONZERO",
    });
    expect(result.blocked?.userMessage).toContain("Không kiểm tra được thông số video");
  });

  it("blocks — never silently passes — on an unexpected probe crash", async () => {
    const { compose } = videoHarness({ probeError: new TypeError("boom") });
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });
    expect(result.blocked).toMatchObject({ code: "INTERNAL", reason: "VIDEO_PROBE_FAILED" });
  });

  it("warns instead of blocking when ffprobe is absent from THIS process", async () => {
    const { compose } = videoHarness({
      probeError: new AppError("INTERNAL", {
        message: "ffprobe binary not found",
        context: { reason: "FFPROBE_NOT_AVAILABLE" },
      }),
    });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });

    expect(result.blocked).toBeNull();
    expect(result.warnings).toContain(VIDEO_NOT_CHECKED_WARNING);
    expect(result.video).toEqual({ target: "facebook_video", spec: null });
  });

  it("warns instead of blocking when no probe is wired at all", async () => {
    const products: ProductRepo = {
      findByCode: async () => product(),
      upsertMany: async () => 0,
      deleteStale: async () => 0,
      countAll: async () => 0,
    };
    const compose = makeComposePost({
      products,
      media: {
        listByProductCode: async () => [clip(1)],
        upsertMany: async () => 0,
        deleteStale: async () => 0,
        ...UPLOAD_STUBS,
      },
      logger: makeLogger(),
    });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
    });

    expect(result.blocked).toBeNull();
    expect(result.warnings).toContain(VIDEO_NOT_CHECKED_WARNING);
  });

  it("carries the spec warnings (silent clip) without blocking", async () => {
    const { compose } = videoHarness({ spec: { ...REELS_SPEC, audioCodec: null } });
    const result = await compose({
      tenantId: TENANT,
      productCode: "MG0AC6017",
      channel: CHANNEL,
      mediaKind: "video",
      videoTarget: "facebook_reels",
    });

    expect(result.blocked).toBeNull();
    expect(result.warnings.join(" ")).toContain("không có tiếng");
  });

  it("never probes a photo post", async () => {
    const { compose, probeAsset } = videoHarness({ media: numbered([1, 2, 3, 4, 5]) });
    const result = await compose({ tenantId: TENANT, productCode: "MGKVX6310", channel: CHANNEL });
    expect(result.blocked).toBeNull();
    expect(result.video).toBeNull();
    expect(probeAsset).not.toHaveBeenCalled();
  });
});

// --- E9 (mode B): the two file modes must not bleed into each other ---------

describe("composePost — media source", () => {
  function uploaded(sequence: number): MediaAsset {
    return asset({
      driveFileId: `upload_${sequence}`,
      origin: "upload",
      storageKey: `${TENANT}/upload_${sequence}`,
      fileName: `tai-len-${sequence}.jpg`,
      color: null,
      colorRaw: null,
      sequence,
    });
  }

  const MIXED = [asset({ sequence: 1 }), asset({ sequence: 2 }), uploaded(1), uploaded(2)];

  it("defaults to Drive and ignores files uploaded for the same code", async () => {
    const compose = harness({ product: product(), media: MIXED });

    const result = await compose({ tenantId: TENANT, productCode: "MGKVX6310", channel: CHANNEL });

    expect(result.blocked).toBeNull();
    expect(result.media.every((item) => item.origin === "drive")).toBe(true);
  });

  it("uses only the uploaded files when asked for mode B", async () => {
    const compose = harness({ product: product(), media: MIXED });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      source: "upload",
    });

    expect(result.blocked).toBeNull();
    expect(result.media.map((item) => item.fileName)).toEqual([
      "tai-len-1.jpg",
      "tai-len-2.jpg",
    ]);
  });

  it("keeps the arranged order, because upload numbers the album by position", async () => {
    const compose = harness({
      product: product(),
      media: [uploaded(3), uploaded(1), uploaded(2)],
    });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      source: "upload",
    });

    expect(result.media.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it("blocks with a mode-B wording when nothing was uploaded", async () => {
    const compose = harness({ product: product(), media: [asset({ sequence: 1 })] });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      source: "upload",
    });

    expect(result.blocked?.reason).toBe("NO_MEDIA_FOR_CODE");
    expect(result.blocked?.userMessage).toMatch(/tải lên/);
  });

  it("still runs the stock gate before looking at uploads at all", async () => {
    // Business rule 1 is order, not mode: mode B must not become a way past it.
    const compose = harness({
      product: product({ operational: { stockRaw: "0", noteRaw: "", colorsRaw: "KEM" } }),
      media: [uploaded(1)],
    });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      source: "upload",
    });

    expect(result.blocked?.code).toBe("OUT_OF_STOCK");
    expect(result.media).toEqual([]);
  });

  it("does not warn about the 5-photo minimum in mode B", async () => {
    const compose = harness({ product: product(), media: [uploaded(1), uploaded(2)] });

    const result = await compose({
      tenantId: TENANT,
      productCode: "MGKVX6310",
      channel: CHANNEL,
      source: "upload",
    });

    expect(result.warnings.some((line) => line.includes("tối thiểu"))).toBe(false);
  });
});
