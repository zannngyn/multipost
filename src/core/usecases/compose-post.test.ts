import { describe, expect, it, vi } from "vitest";

import type { MediaAsset, Product } from "@/core/domain/product";
import type { Logger } from "@/core/ports/infra";
import type { MediaRepo, ProductRepo } from "@/core/ports/product-repo";

import { makeComposePost } from "./compose-post";

const TENANT = "00000000-0000-0000-0000-000000000001";
const CHANNEL = "fb-page-1";

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
  };
  const media: MediaRepo = {
    listByProductCode: async () => options.media ?? [],
    upsertMany: async () => 0,
    deleteStale: async () => 0,
  };
  return makeComposePost({ products, media, logger: makeLogger() });
}

const numbered = (numbers: number[], color = "KEM") =>
  numbers.map((sequence) =>
    asset({ sequence, color, colorRaw: color, fileName: `MGKVX6310-${color} (${sequence}).jpg` }),
  );

describe("composePost — edge cases first", () => {
  it.each([
    ["bad tenant", { tenantId: "nope", productCode: "MGKVX6310", channel: CHANNEL }],
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
    };
    const media: MediaRepo = { listByProductCode, upsertMany: async () => 0, deleteStale: async () => 0 };
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
