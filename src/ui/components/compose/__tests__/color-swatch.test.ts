import { describe, expect, it } from "vitest";

import { colorSwatch, swatchKey } from "../color-swatch";

/**
 * The dot on a colour chip. The rule being protected: we NEVER invent a colour
 * we cannot name — an invented hex is a lie about the photos in the post.
 */

describe("swatchKey", () => {
  it("collapses the spellings the pipeline can produce", () => {
    expect(swatchKey("TRẮNG")).toBe("TRANG");
    expect(swatchKey(" trắng ")).toBe("TRANG");
    expect(swatchKey("Xanh  Rêu")).toBe("XANH REU");
    expect(swatchKey("ĐEN")).toBe("DEN");
  });

  it("answers an empty key for junk instead of throwing", () => {
    expect(swatchKey("")).toBe("");
    expect(swatchKey("   ")).toBe("");
    expect(swatchKey(undefined as unknown as string)).toBe("");
  });
});

describe("colorSwatch", () => {
  it("returns null for a colour it does not know", () => {
    expect(colorSwatch("MÀU LẠ")).toBeNull();
    expect(colorSwatch("")).toBeNull();
  });

  it("matches a canonical colour whatever the accents", () => {
    expect(colorSwatch("TRẮNG")).toBe("#FFFFFF");
    expect(colorSwatch("trang")).toBe("#FFFFFF");
  });

  it("keeps two-word colours distinct from their first word", () => {
    expect(colorSwatch("XANH")).not.toBe(colorSwatch("XANH THAN"));
    expect(colorSwatch("NÂU BE")).not.toBe(colorSwatch("NÂU"));
  });

  it("falls back to the leading words, not to a default colour", () => {
    // Not in the list; "XANH RÊU" is, so the dot follows the nearest real name.
    expect(colorSwatch("XANH RÊU ĐẬM")).toBe(colorSwatch("XANH RÊU"));
    // Nothing to fall back to → null, never a stand-in colour.
    expect(colorSwatch("ABC XYZ")).toBeNull();
  });
});
