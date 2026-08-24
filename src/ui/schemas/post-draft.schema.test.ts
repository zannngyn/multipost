import { describe, expect, it } from "vitest";

import {
  COMPOSE_DRAFT_MAX_BYTES,
  ComposeDraftPayloadSchema,
  DRAFT_PAYLOAD_INVALID,
  DRAFT_PAYLOAD_REJECTED,
  composeDraftByteLength,
  exceedsComposeDraftLimit,
  findForbiddenDraftKeys,
  parseComposeDraftPayload,
  type ComposeDraftPayload,
} from "./post-draft.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1): everything a draft can be when
 * it comes back from storage or from another build, then the happy path.
 */

function validPayload(overrides: Partial<ComposeDraftPayload> = {}): ComposeDraftPayload {
  return {
    step: "caption",
    composeKey: "MGKVX6310|trắng|image|-",
    productCode: "MGKVX6310",
    color: "TRẮNG",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: { facebook: "Áo dài trắng — mã MGKVX6310" },
    captionOverrides: { facebook: "Áo dài trắng, hàng mới về" },
    albumOrder: ["drive-file-1", "drive-file-2"],
    selectedChannelIds: ["page-a", "page-b"],
    shareCaption: true,
    schedule: { mode: "scheduled", value: "2026-08-20T09:30" },
    savedAt: "2026-08-17T03:04:05.000Z",
    ...overrides,
  };
}

describe("findForbiddenDraftKeys", () => {
  it("finds nothing in a clean payload", () => {
    expect(findForbiddenDraftKeys(validPayload())).toEqual([]);
  });

  it("reports the path of a forbidden key at any depth, including inside arrays", () => {
    const paths = findForbiddenDraftKeys({
      captions: { facebook: "ok", price: "199.000đ" },
      media: [{ fileName: "a.jpg" }, { signedUrl: "https://x" }],
    });
    expect(paths).toEqual(["captions.price", "media[1].signedUrl"]);
  });

  it("matches ignoring case and separators, so luu_y and LUU-Y are the same key", () => {
    expect(findForbiddenDraftKeys({ LUU_Y: "HẾT HÀNG" })).toEqual(["LUU_Y"]);
    expect(findForbiddenDraftKeys({ "luu-y": "x" })).toEqual(["luu-y"]);
    expect(findForbiddenDraftKeys({ MediaURL: "x" })).toEqual(["MediaURL"]);
  });

  it("does not hang on a cyclic object", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    expect(findForbiddenDraftKeys(node)).toEqual([]);
  });

  it("ignores primitives and null", () => {
    expect(findForbiddenDraftKeys(null)).toEqual([]);
    expect(findForbiddenDraftKeys("price")).toEqual([]);
    expect(findForbiddenDraftKeys(42)).toEqual([]);
  });
});

describe("parseComposeDraftPayload — edge cases", () => {
  it("refuses anything that is not an object", () => {
    for (const value of [null, undefined, "draft", 7, []]) {
      const result = parseComposeDraftPayload(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(DRAFT_PAYLOAD_INVALID);
    }
  });

  it("REJECTS a forbidden field instead of stripping it", () => {
    const result = parseComposeDraftPayload({ ...validPayload(), stock: 0 });
    if (result.ok || result.code !== DRAFT_PAYLOAD_REJECTED) {
      throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    }
    expect(result.forbiddenPaths).toEqual(["stock"]);
    expect(result.userMessage).toContain("không được phép");
  });

  it("rejects a forbidden field nested inside the caption record", () => {
    const payload = validPayload();
    const result = parseComposeDraftPayload({
      ...payload,
      captions: { ...payload.captions, price: "199.000đ" },
    });
    if (result.ok || result.code !== DRAFT_PAYLOAD_REJECTED) {
      throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    }
    expect(result.forbiddenPaths).toEqual(["captions.price"]);
  });

  it("rejects every key on the forbidden list", () => {
    const forbidden = [
      { stock: 1 },
      { inventory: {} },
      { price: 1 },
      { prices: [] },
      { note: "x" },
      { notes: "x" },
      { luu_y: "HẾT HÀNG" },
      { ton: 0 },
      { mediaUrl: "https://x" },
      { signedUrl: "https://x" },
      { url: "https://x" },
    ];
    for (const extra of forbidden) {
      const result = parseComposeDraftPayload({ ...validPayload(), ...extra });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(DRAFT_PAYLOAD_REJECTED);
    }
  });

  it("refuses an unknown extra field rather than dropping it silently", () => {
    const result = parseComposeDraftPayload({ ...validPayload(), autoPublish: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DRAFT_PAYLOAD_INVALID);
  });

  it("refuses a step slug the wizard does not have", () => {
    const result = parseComposeDraftPayload({ ...validPayload(), step: "duyet" });
    if (result.ok || result.code !== DRAFT_PAYLOAD_INVALID) {
      throw new Error(`expected an invalid verdict, got ${JSON.stringify(result)}`);
    }
    expect(result.issuePaths).toContain("step");
  });

  it("refuses a missing or non-ISO savedAt", () => {
    expect(parseComposeDraftPayload({ ...validPayload(), savedAt: "hôm qua" }).ok).toBe(false);
    const { savedAt: _savedAt, ...withoutSavedAt } = validPayload();
    expect(parseComposeDraftPayload(withoutSavedAt).ok).toBe(false);
  });

  it("refuses a schedule that is not the shape useScheduleChoice holds", () => {
    expect(
      parseComposeDraftPayload({ ...validPayload(), schedule: { mode: "later", value: "" } }).ok,
    ).toBe(false);
    // `error` belongs to the last resolve(), not to the operator's input.
    expect(
      parseComposeDraftPayload({
        ...validPayload(),
        schedule: { mode: "now", value: "", error: "Giờ hẹn đăng đã trôi qua" },
      }).ok,
    ).toBe(false);
  });

  it("refuses an unknown media kind", () => {
    expect(parseComposeDraftPayload({ ...validPayload(), mediaKind: "carousel" }).ok).toBe(false);
  });

  it("refuses an over-long caption and too many channels (same caps as core)", () => {
    expect(
      parseComposeDraftPayload({
        ...validPayload(),
        captions: { facebook: "x".repeat(20_001) },
      }).ok,
    ).toBe(false);

    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`channel-${index}`, "x"]),
    );
    expect(parseComposeDraftPayload({ ...validPayload(), captions: many }).ok).toBe(false);
  });

  it("refuses an empty id in a list — an album entry with no id restores nothing", () => {
    expect(parseComposeDraftPayload({ ...validPayload(), albumOrder: [""] }).ok).toBe(false);
    expect(parseComposeDraftPayload({ ...validPayload(), selectedChannelIds: [""] }).ok).toBe(false);
  });
});

/**
 * The client mirrors `core/domain/post-draft.ts` and must never be STRICTER: a
 * draft the server happily stored, refused on the way back, is the data loss
 * this feature exists to prevent.
 */
describe("parseComposeDraftPayload — accepts everything core accepts", () => {
  it("accepts an empty product code (autosave fires on a half-typed step 1)", () => {
    const result = parseComposeDraftPayload(
      validPayload({ productCode: "", composeKey: "", color: "" }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a savedAt core would accept but z.iso.datetime() would not", () => {
    expect(parseComposeDraftPayload(validPayload({ savedAt: "2026-08-17T10:00:00+07:00" })).ok).toBe(
      true,
    );
  });

  it("accepts the 256-char ceiling on the short text fields", () => {
    const long = "x".repeat(256);
    expect(
      parseComposeDraftPayload(
        validPayload({
          productCode: long,
          color: long,
          composeKey: long,
          schedule: { mode: "scheduled", value: long },
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("parseComposeDraftPayload — happy path", () => {
  it("round-trips a draft through JSON unchanged", () => {
    const payload = validPayload();
    const result = parseComposeDraftPayload(JSON.parse(JSON.stringify(payload)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  it("accepts an untouched draft: step 1, no channel, no caption, đăng ngay", () => {
    const result = parseComposeDraftPayload(
      validPayload({
        step: "san-pham",
        composeKey: "",
        color: "",
        captions: {},
        captionOverrides: {},
        albumOrder: [],
        selectedChannelIds: [],
        shareCaption: false,
        schedule: { mode: "now", value: "" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("exposes the same verdict through the schema itself", () => {
    expect(ComposeDraftPayloadSchema.safeParse(validPayload()).success).toBe(true);
    expect(ComposeDraftPayloadSchema.safeParse({ ...validPayload(), stock: 0 }).success).toBe(false);
  });
});

describe("composeDraftByteLength", () => {
  it("measures UTF-8 bytes, not characters", () => {
    // JSON is `"Áo"`: two quotes + one 2-byte character + one 1-byte character.
    expect(composeDraftByteLength("Áo")).toBe(5);
    expect(exceedsComposeDraftLimit(validPayload())).toBe(false);
  });

  it("flags a payload the server would answer 413 to", () => {
    const huge = validPayload({ captions: { facebook: "x".repeat(COMPOSE_DRAFT_MAX_BYTES) } });
    expect(exceedsComposeDraftLimit(huge)).toBe(true);
  });
});
