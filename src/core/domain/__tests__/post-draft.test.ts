import { describe, expect, it } from "vitest";

import { AppError } from "../errors";
import {
  assertComposeDraftPayload,
  assertPostDraftAddress,
  normalisePostDraftKind,
  parseComposeDraftPayload,
  POST_DRAFT_KIND_COMPOSE,
  POST_DRAFT_MAX_BYTES,
  POST_DRAFT_SCHEMA_VERSION,
  type ComposeDraftPayload,
} from "../post-draft";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OWNER = "00000000-0000-0000-0000-0000000000aa";

function valid(overrides: Partial<ComposeDraftPayload> = {}): ComposeDraftPayload {
  return {
    step: "caption",
    composeKey: "AB123|đỏ|image|-",
    productCode: "AB123",
    color: "ĐỎ",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: { facebook: "Váy hoa nhí mùa hè" },
    captionOverrides: {},
    albumOrder: ["asset-1", "asset-2"],
    selectedChannelIds: ["1234567890"],
    shareCaption: true,
    schedule: { mode: "now", value: "" },
    savedAt: "2026-08-17T03:04:05.000Z",
    ...overrides,
  };
}

/** The valid payload minus one key, as an untyped bag (a client may send anything). */
function without(key: keyof ComposeDraftPayload): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...valid() };
  delete payload[key];
  return payload;
}

/**
 * `expect(fn).toThrowError(matcher)` only compares the message; these assertions
 * are about the CODE and the context, so the error is caught explicitly.
 */
function expectThrows(fn: () => unknown, expected: Record<string, unknown>): AppError {
  try {
    fn();
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    expect(error).toMatchObject(expected);
    return error as AppError;
  }
  throw new Error("expected the call to throw, it returned normally");
}

describe("assertComposeDraftPayload — not an object", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "{}"],
    ["a number", 42],
    ["an array", [{ step: "caption" }]],
  ])("rejects %s", (_label, value) => {
    expectThrows(() => assertComposeDraftPayload(value), {
      code: "DRAFT_PAYLOAD_REJECTED",
      context: { reason: "NOT_AN_OBJECT" },
    });
  });
});

describe("assertComposeDraftPayload — forbidden keys (business rule 2 + 5)", () => {
  it.each([
    "stock",
    "inventory",
    "price",
    "prices",
    "note",
    "notes",
    "luu_y",
    "ton",
    "mediaUrl",
    "signedUrl",
    "url",
  ])("rejects top-level key %s instead of stripping it", (key) => {
    expectThrows(() => assertComposeDraftPayload({ ...valid(), [key]: "anything" }), {
      code: "DRAFT_PAYLOAD_REJECTED",
      context: { reason: "FORBIDDEN_KEY", key },
    });
  });

  it.each(["Price", "PRICE", "LUU_Y", "media-url", "media_url", "Signed_Url", "TON"])(
    "normalises the key before matching: %s",
    (key) => {
      expectThrows(() => assertComposeDraftPayload({ ...valid(), [key]: 1 }), {
        code: "DRAFT_PAYLOAD_REJECTED",
        context: { reason: "FORBIDDEN_KEY", key },
      });
    },
  );

  it("finds a forbidden key nested inside an object", () => {
    expectThrows(
      () => assertComposeDraftPayload({ ...valid(), schedule: { mode: "now", value: "", price: 1 } }),
      {
        code: "DRAFT_PAYLOAD_REJECTED",
        context: { reason: "FORBIDDEN_KEY", key: "price", path: "schedule.price" },
      },
    );
  });

  it("finds a forbidden key nested inside an array", () => {
    expectThrows(
      () =>
        assertComposeDraftPayload({
          ...valid(),
          albumOrder: [{ id: "a", signedUrl: "https://x" }],
        }),
      {
        code: "DRAFT_PAYLOAD_REJECTED",
        context: { reason: "FORBIDDEN_KEY", key: "signedUrl", path: "albumOrder[0].signedUrl" },
      },
    );
  });

  it("does not confuse a forbidden key with a caption that mentions the word", () => {
    const payload = valid({ captions: { facebook: "Giá tốt — xem url shop nhé" } });
    expect(assertComposeDraftPayload(payload).captions.facebook).toContain("url");
  });

  it("refuses a structure nested deeper than the draft shape rather than stopping the scan", () => {
    const deep = { a: { b: { c: { d: { e: { f: { price: 1 } } } } } } };
    expectThrows(() => assertComposeDraftPayload({ ...valid(), extra: deep }), {
      code: "DRAFT_PAYLOAD_REJECTED",
      context: { reason: "TOO_DEEP" },
    });
  });
});

describe("assertComposeDraftPayload — size", () => {
  it("rejects a payload over POST_DRAFT_MAX_BYTES with its own code", () => {
    const payload = valid({ captions: { facebook: "x".repeat(POST_DRAFT_MAX_BYTES + 1) } });

    const error = expectThrows(() => assertComposeDraftPayload(payload), {
      code: "DRAFT_TOO_LARGE",
      context: { reason: "OVER_SIZE_LIMIT", limit_bytes: POST_DRAFT_MAX_BYTES },
    });
    expect(Number(error.context.bytes)).toBeGreaterThan(POST_DRAFT_MAX_BYTES);
  });

  it("counts UTF-8 bytes, not characters — Vietnamese text is up to 3 bytes/char", () => {
    // 22k ASCII characters would fit; 22k of these do not.
    const payload = valid({ captions: { facebook: "ữ".repeat(22_000) } });
    expectThrows(() => assertComposeDraftPayload(payload), { code: "DRAFT_TOO_LARGE" });
  });

  it("accepts a large but legal payload", () => {
    const payload = valid({ captions: { facebook: "x".repeat(10_000) } });
    expect(assertComposeDraftPayload(payload).captions.facebook.length).toBe(10_000);
  });

  it("rejects a circular payload instead of throwing a raw TypeError", () => {
    const payload: Record<string, unknown> = { ...valid() };
    payload.self = payload;

    expectThrows(() => assertComposeDraftPayload(payload), {
      code: "DRAFT_PAYLOAD_REJECTED",
      context: { reason: "NOT_SERIALISABLE" },
    });
  });
});

describe("assertComposeDraftPayload — shape", () => {
  it.each([
    "step",
    "composeKey",
    "productCode",
    "color",
    "mediaKind",
    "videoTarget",
    "source",
    "captions",
    "captionOverrides",
    "albumOrder",
    "selectedChannelIds",
    "shareCaption",
    "schedule",
    "savedAt",
  ] as const)("rejects a payload missing %s", (key) => {
    expectThrows(() => assertComposeDraftPayload(without(key)), {
      code: "DRAFT_PAYLOAD_REJECTED",
      context: { reason: "SCHEMA_MISMATCH" },
    });
  });

  it("rejects an unknown key — that is how composed content would sneak in", () => {
    expectThrows(() => assertComposeDraftPayload({ ...valid(), composed: { media: [] } }), {
      code: "DRAFT_PAYLOAD_REJECTED",
      context: { reason: "SCHEMA_MISMATCH" },
    });
  });

  it.each([
    ["step", "xem-lai-roi"],
    ["mediaKind", "audio"],
    ["videoTarget", "tiktok"],
    ["source", "dropbox"],
  ])("rejects %s = %s outside its enum", (key, value) => {
    expectThrows(() => assertComposeDraftPayload({ ...valid(), [key]: value }), {
      code: "DRAFT_PAYLOAD_REJECTED",
    });
  });

  it.each(["", "hôm qua", "2026-13-45T99:99:99Z"])("rejects savedAt = %s", (savedAt) => {
    expectThrows(() => assertComposeDraftPayload({ ...valid(), savedAt }), {
      code: "DRAFT_PAYLOAD_REJECTED",
    });
  });

  it("rejects a caption map whose value is not a string", () => {
    expectThrows(() => assertComposeDraftPayload({ ...valid(), captions: { facebook: 12 } }), {
      code: "DRAFT_PAYLOAD_REJECTED",
    });
  });

  it("reports the failing paths so the UI can show them", () => {
    const error = expectThrows(
      () => assertComposeDraftPayload({ ...valid(), step: "nope", shareCaption: "yes" }),
      { code: "DRAFT_PAYLOAD_REJECTED" },
    );
    const issues = error.context.issues as { path: string }[];
    expect(issues.map((issue) => issue.path).sort()).toEqual(["shareCaption", "step"]);
  });
});

describe("assertComposeDraftPayload — happy path", () => {
  it("accepts a half-filled draft: autosave fires before step 1 is complete", () => {
    const payload = valid({
      step: "san-pham",
      composeKey: "",
      productCode: "",
      color: "",
      captions: {},
      captionOverrides: {},
      albumOrder: [],
      selectedChannelIds: [],
      shareCaption: false,
      schedule: { mode: "scheduled", value: "2026-08-18T09:00" },
    });

    expect(assertComposeDraftPayload(payload)).toEqual(payload);
  });

  it("returns the payload unchanged — it never cleans, it only accepts or refuses", () => {
    const payload = valid();
    expect(assertComposeDraftPayload({ ...payload })).toEqual(payload);
  });
});

describe("parseComposeDraftPayload", () => {
  it("reports instead of throwing for a rejected payload", () => {
    const result = parseComposeDraftPayload({ ...valid(), price: 9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DRAFT_PAYLOAD_REJECTED");
  });

  it("reports an oversized payload with its own code", () => {
    const result = parseComposeDraftPayload(
      valid({ captions: { facebook: "x".repeat(POST_DRAFT_MAX_BYTES + 1) } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DRAFT_TOO_LARGE");
  });

  it("passes a valid payload through", () => {
    const result = parseComposeDraftPayload(valid());
    expect(result.ok).toBe(true);
  });
});

describe("normalisePostDraftKind", () => {
  it.each([undefined, null, "", "   "])("defaults %s to the compose kind", (value) => {
    expect(normalisePostDraftKind(value)).toBe(POST_DRAFT_KIND_COMPOSE);
  });

  it("trims and lower-cases", () => {
    expect(normalisePostDraftKind("  Compose  ")).toBe("compose");
  });

  it.each(["kind with space", "compose!", "x".repeat(41), 7])(
    "rejects the malformed kind %s instead of falling back",
    (value) => {
      expectThrows(() => normalisePostDraftKind(value), { code: "INVALID_INPUT" });
    },
  );
});

describe("assertPostDraftAddress", () => {
  it.each([undefined, null, {}, { tenantId: testTenantId("") }, { tenantId: testTenantId("not-a-uuid") }])(
    "rejects a malformed tenant id: %s",
    (input) => {
      expectThrows(() => assertPostDraftAddress(input as never), {
        code: "INVALID_INPUT",
        context: { reason: "INVALID_TENANT_ID" },
      });
    },
  );

  it.each(["", "   ", "someone@example.com", "12345"])(
    "rejects owner user id %s — a shared draft is worse than no draft",
    (ownerUserId) => {
      expectThrows(() => assertPostDraftAddress({ tenantId: TENANT, ownerUserId }), {
        code: "INVALID_INPUT",
        context: { reason: "INVALID_OWNER_USER_ID" },
      });
    },
  );

  it("trims and defaults the kind", () => {
    expect(assertPostDraftAddress({ tenantId: testTenantId(` ${TENANT} `), ownerUserId: ` ${OWNER} ` })).toEqual({
      tenantId: TENANT,
      ownerUserId: OWNER,
      kind: POST_DRAFT_KIND_COMPOSE,
    });
  });
});

describe("schema version", () => {
  it("is 1 until a payload change forces a bump", () => {
    expect(POST_DRAFT_SCHEMA_VERSION).toBe(1);
  });
});
