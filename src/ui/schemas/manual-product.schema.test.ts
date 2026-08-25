import { describe, expect, it } from "vitest";

import {
  EMPTY_MANUAL_PRODUCT,
  MANUAL_PRODUCT_CONTENT_FIELDS,
  MANUAL_PRODUCT_FIELDS,
  ManualProductFormSchema,
  isManualProductField,
  manualProductCaptionKey,
  manualProductEntry,
  manualProductForCode,
  toManualProductPayload,
  type ManualProductFormValues,
} from "@/ui/schemas/manual-product.schema";

function values(overrides: Partial<ManualProductFormValues> = {}): ManualProductFormValues {
  return { ...EMPTY_MANUAL_PRODUCT, name: "Váy hoa nhí", ...overrides };
}

/**
 * Edge cases first (CLAUDE.md technical rule 1). The two that matter here are
 * business rules, not typing mistakes: a seventh field would be a hole in the
 * caption whitelist, and a client-side stock requirement would either lock out a
 * `stockPolicy.disabled` tenant or pretend the gate lives in the browser.
 */
describe("manual product — the whitelist", () => {
  it("carries exactly the four caption fields plus the two operational ones", () => {
    expect([...MANUAL_PRODUCT_FIELDS]).toEqual([
      "name",
      "description",
      "category",
      "season",
      "stockRaw",
      "noteRaw",
    ]);
    expect([...MANUAL_PRODUCT_CONTENT_FIELDS]).toEqual([
      "name",
      "description",
      "category",
      "season",
    ]);
  });

  it("sends those six keys and nothing else, whatever the form object holds", () => {
    // A form value carrying a stray key is exactly what the strict server schema
    // answers 400 for. The payload builder must not be the thing that lets it
    // through.
    const contaminated = { ...values(), price: "385.000" } as ManualProductFormValues;

    expect(Object.keys(toManualProductPayload(contaminated)).sort()).toEqual([
      "category",
      "description",
      "name",
      "noteRaw",
      "season",
      "stockRaw",
    ]);
  });

  it("trims every field before it travels", () => {
    const payload = toManualProductPayload(
      values({ name: "  Váy hoa nhí  ", stockRaw: " 12 ", noteRaw: "  " }),
    );
    expect(payload.name).toBe("Váy hoa nhí");
    expect(payload.stockRaw).toBe("12");
    expect(payload.noteRaw).toBe("");
  });

  it("recognises only its own field paths for a server issue", () => {
    expect(isManualProductField("name")).toBe(true);
    expect(isManualProductField("stockRaw")).toBe(true);
    expect(isManualProductField("productCode")).toBe(false);
    expect(isManualProductField("price")).toBe(false);
  });
});

describe("manual product — validation", () => {
  it("refuses an empty name: every caption opens with it", () => {
    const result = ManualProductFormSchema.safeParse(values({ name: "   " }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["name"]);
  });

  /**
   * The gate is the SERVER's (business rule 3). The form warns, then lets the
   * request through so `stockPolicy.disabled` — the one legitimate way to post
   * without a number — is not blocked by a browser that cannot know the policy.
   */
  it("accepts an empty stock so the server can be the one to block it", () => {
    const result = ManualProductFormSchema.safeParse(values({ stockRaw: "" }));
    expect(result.success).toBe(true);
    expect(toManualProductPayload(result.data!).stockRaw).toBe("");
  });

  it("refuses a name longer than the server would take", () => {
    expect(ManualProductFormSchema.safeParse(values({ name: "x".repeat(201) })).success).toBe(false);
    expect(ManualProductFormSchema.safeParse(values({ name: "x".repeat(200) })).success).toBe(true);
  });
});

describe("manualProductCaptionKey", () => {
  it("is empty when nothing was typed, so a synced post keeps its old key", () => {
    expect(manualProductCaptionKey(null)).toBe("");
  });

  it("changes when a caption field changes", () => {
    expect(manualProductCaptionKey(values({ name: "Váy A" }))).not.toBe(
      manualProductCaptionKey(values({ name: "Váy B" })),
    );
  });

  it("does NOT change when only the stock or the note changes", () => {
    // Rewriting a stock number does not rewrite a single word of the caption;
    // throwing an approved caption away over it would be a fake invalidation.
    expect(manualProductCaptionKey(values({ stockRaw: "12", noteRaw: "sx 1c" }))).toBe(
      manualProductCaptionKey(values({ stockRaw: "40", noteRaw: "" })),
    );
  });

  it("ignores case and repeated whitespace, which are not a different product", () => {
    expect(manualProductCaptionKey(values({ name: "  VÁY   Hoa nhí " }))).toBe(
      manualProductCaptionKey(values({ name: "váy hoa nhí" })),
    );
  });

  it("cannot collide by shifting characters between fields", () => {
    expect(manualProductCaptionKey(values({ name: "ab", description: "c" }))).not.toBe(
      manualProductCaptionKey(values({ name: "a", description: "bc" })),
    );
  });
});

/**
 * The binding between typed data and its code. Edge cases first: this exists to
 * stop typed data following the operator onto the NEXT code, where the server
 * would answer MANUAL_PRODUCT_CONFLICT about a form they thought they had left.
 */
describe("manualProductForCode", () => {
  const entry = manualProductEntry("mgkvx6310 ", values({ name: "Váy hoa nhí" }));

  it("normalises the code the same way the server does", () => {
    expect(entry.productCode).toBe("MGKVX6310");
    expect(manualProductForCode(entry, " mgkvx6310 ")?.name).toBe("Váy hoa nhí");
  });

  it("returns nothing for another code — that lookup goes to the synced catalog", () => {
    expect(manualProductForCode(entry, "MGKSQ6031")).toBeNull();
  });

  it("returns nothing when nothing was typed", () => {
    expect(manualProductForCode(null, "MGKVX6310")).toBeNull();
  });

  it("returns nothing when the stored code is blank", () => {
    expect(manualProductForCode(manualProductEntry("  ", values()), "")).toBeNull();
  });
});
