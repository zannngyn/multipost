import { describe, expect, it } from "vitest";

import {
  colorKey,
  isProductCode,
  isSameColor,
  mediaKindFromMimeType,
  normalizeColorName,
  parseMediaFileName,
} from "./media-file-name";

/** Helper: unwrap a successful parse or fail loudly with the issue. */
function parsed(name: string) {
  const result = parseMediaFileName(name);
  if (!result.ok) throw new Error(`expected ok parse for '${name}', got ${result.issue}`);
  return result.value;
}

describe("parseMediaFileName — edge cases first", () => {
  it("rejects an empty or whitespace-only name without throwing", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      const result = parseMediaFileName(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issue).toBe("EMPTY_NAME");
      expect(result.raw).toBe(raw);
    }
  });

  it("rejects non-string input as EMPTY_NAME instead of crashing", () => {
    const result = parseMediaFileName(undefined as unknown as string);
    expect(result).toMatchObject({ ok: false, issue: "EMPTY_NAME" });
  });

  // Real names from sample-data/drive-file-listing.txt.
  it.each([
    "IMG_1664.JPG",
    "1.jpg",
    "a3.png",
    "_prompt_chuyn_4k_202601191649.jpeg",
    "7F98EC09-1234.jpeg",
    "Model_wearing_pink_ruffled_dress_202608070908.jpeg",
  ])("rejects '%s' with NO_PRODUCT_CODE", (name) => {
    const result = parseMediaFileName(name);
    expect(result).toMatchObject({ ok: false, issue: "NO_PRODUCT_CODE" });
  });

  it("rejects a code that appears but does not open the name", () => {
    const result = parseMediaFileName("DV Huyền Thạch MGAC513 MMQD554.jpg");
    expect(result).toMatchObject({ ok: false, issue: "NO_PRODUCT_CODE" });
    // The detail is read by an operator, so it is Vietnamese — and it still
    // names the code that was found, which is how the file gets renamed.
    if (!result.ok) {
      expect(result.detail).toContain("MGAC513");
      expect(result.detail).toContain("không đứng đầu");
    }
  });

  it("attributes an outfit-set photo to the leading code and flags it", () => {
    // PENDING(docs/05 section 7 question 6): 739 real files carry two codes.
    const value = parsed("MG0AD6051-MR0CV6068-AI (1).png");
    expect(value.productCode).toBe("MG0AD6051");
    expect(value.otherProductCodes).toEqual(["MR0CV6068"]);
    expect(value.warnings).toContain("MULTIPLE_PRODUCT_CODES");
    expect(value.isStrict).toBe(false);
  });

  it("does not invent a second code from a glued repetition", () => {
    const value = parsed("MGTT5139-HỒNG TÍMMGTT5139-HONGTIM");
    expect(value.productCode).toBe("MGTT5139");
    expect(value.otherProductCodes).toEqual([]);
    expect(value.warnings).toContain("REPEATED_PRODUCT_CODE");
    expect(value.color).toBe("HỒNG TÍM");
  });

  it("accepts the same code written twice, flagging it", () => {
    const value = parsed("MG0AD6112-KEMMG0AD6112-AI");
    expect(value.productCode).toBe("MG0AD6112");
    expect(value.warnings).toContain("REPEATED_PRODUCT_CODE");
  });

  it("strips leading tabs/spaces and records the deviation", () => {
    const value = parsed("   \t MGSQ5202-XANH.jpg");
    expect(value.productCode).toBe("MGSQ5202");
    expect(value.color).toBe("XANH");
    expect(value.warnings).toContain("LEADING_TRAILING_WHITESPACE");
    expect(value.isStrict).toBe(false);
  });

  it("keeps files without a sequence number usable", () => {
    const value = parsed("MGSQ5202-2-XANH.jpg");
    expect(value.sequence).toBeNull();
    expect(value.color).toBe("XANH");
    expect(value.warnings).toContain("MISSING_SEQUENCE");
    expect(value.extraTokens).toContain("2");
  });

  it("keeps files without an extension usable and treats them as images", () => {
    const value = parsed("MGKVX6310-BE-AI (4)");
    expect(value.extension).toBeNull();
    expect(value.kind).toBe("image");
    expect(value.color).toBe("BE");
    expect(value.variants.aiGenerated).toBe(true);
    expect(value.warnings).toContain("MISSING_EXTENSION");
  });

  it("flags an unknown extension instead of dropping the file", () => {
    const value = parsed("MGKVX6310-KEM (2).heic");
    expect(value.extension).toBe("heic");
    expect(value.kind).toBe("image");
    expect(value.warnings).toContain("UNKNOWN_EXTENSION");
  });

  it("recovers an extension written without a dot", () => {
    expect(parsed("MMAD538JPG").extension).toBe("jpg");
    expect(parsed("MG0AD6021-AI (10) mp4")).toMatchObject({ extension: "mp4", kind: "video" });
    expect(parsed("MMAD538JPG").warnings).toContain("EXTENSION_WITHOUT_DOT");
  });

  it("marks a name whose colour slot holds only 'AI'", () => {
    const value = parsed("BG0SQ6083-AI (1).png");
    expect(value.color).toBeNull();
    expect(value.variants.aiGenerated).toBe(true);
    expect(value.warnings).toContain("MISSING_COLOR");
  });

  it("keeps an unknown colour as raw text and flags it, never guessing", () => {
    const value = parsed("MG0SV6055-PIERA (3).jpg");
    expect(value.color).toBeNull();
    expect(value.colorRaw).toBe("PIERA");
    expect(value.warnings).toContain("UNKNOWN_COLOR");
  });

  it("does not fold a model name into the colour", () => {
    const value = parsed("MGAD5115-XANH THAN- Diễn viên Cù Thị Trà");
    expect(value.color).toBe("XANH THAN");
    expect(value.extraTokens).toEqual(["Diễn viên Cù Thị Trà"]);
    expect(value.warnings).toContain("EXTRA_TOKENS");
  });
});

describe("parseMediaFileName — happy path and variants", () => {
  it("parses the brief's canonical example as strict", () => {
    const value = parsed("MRKVX6371-Tím (25).jpg");
    expect(value).toMatchObject({
      productCode: "MRKVX6371",
      color: "TÍM",
      colorRaw: "Tím",
      sequence: 25,
      extension: "jpg",
      kind: "image",
      isStrict: true,
    });
    expect(value.warnings).toEqual([]);
  });

  it("classifies video extensions", () => {
    expect(parsed("MG0AC6017-AI.mp4").kind).toBe("video");
    expect(parsed("MG0AC6017-AI.mov").kind).toBe("video");
  });

  it("splits the -AI marker from the colour", () => {
    const value = parsed("MGKAD6045-XANH-AI (13).jpeg");
    expect(value.color).toBe("XANH");
    expect(value.variants).toEqual({ aiGenerated: true, realPhoto: false, backView: false });
    expect(value.isStrict).toBe(true);
  });

  it("splits the -THỰC TẾ marker", () => {
    const value = parsed("MGKVX6310-KEM-THỰC TẾ.png");
    expect(value.color).toBe("KEM");
    expect(value.variants.realPhoto).toBe(true);
  });

  it.each([
    ["MGKVX6310-Hồng-Mặt sau(55).jpeg", "HỒNG", 55],
    ["MGKAD6045-MẶTSAU-XANH (302).jpeg", "XANH", 302],
  ])("splits back-view markers in '%s'", (name, color, sequence) => {
    const value = parsed(name);
    expect(value.color).toBe(color);
    expect(value.sequence).toBe(sequence);
    expect(value.variants.backView).toBe(true);
  });

  it("handles a marker separated by a space from the colour", () => {
    const value = parsed("MMVX5282-TRẮNG AI (2).jpg");
    expect(value.color).toBe("TRẮNG");
    expect(value.variants.aiGenerated).toBe(true);
  });

  it("reads a sequence written before the colour", () => {
    const value = parsed("MGKAD6045 (123)-XANH.jpeg");
    expect(value).toMatchObject({ sequence: 123, color: "XANH" });
  });

  it("keeps multi-word colours intact", () => {
    expect(parsed("MGKSQ6309-NÂU VÀNG-AI (1)").color).toBe("NÂU VÀNG");
    expect(parsed("MR0AC6080-TRẮNG TIÊU-AI (1).jpg").color).toBe("TRẮNG TIÊU");
    expect(parsed("MGAD506-XANH DƯƠNG").color).toBe("XANH DƯƠNG");
  });

  it("lower-cased codes still resolve", () => {
    expect(parsed("Mgkvx6310-CAM-AI (26).jpeg").productCode).toBe("MGKVX6310");
  });
});

describe("colour normalisation", () => {
  it.each([
    ["TRANG", "TRẮNG"],
    ["trắng", "TRẮNG"],
    ["Trang", "TRẮNG"],
    ["DEN", "ĐEN"],
    ["ĐEN", "ĐEN"],
    ["DO", "ĐỎ"],
    ["NAU", "NÂU"],
    ["VANG", "VÀNG"],
    ["XANHTHAN", "XANH THAN"],
    ["XANH THAN", "XANH THAN"],
    ["HONGKEM", "HỒNG KEM"],
    ["NAUBE", "NÂU BE"],
    ["hồng tím", "HỒNG TÍM"],
  ])("maps '%s' to '%s'", (raw, canonical) => {
    expect(normalizeColorName(raw)).toBe(canonical);
  });

  it("returns null for anything that is not a colour", () => {
    for (const raw of ["", "  ", "PIERA", "Jess Yul", "OD", "AI"]) {
      expect(normalizeColorName(raw)).toBeNull();
    }
  });

  it("treats spelling variants of one colour as the same colour", () => {
    expect(isSameColor("NAU", "NÂU")).toBe(true);
    expect(isSameColor("XANHTHAN", "xanh than")).toBe(true);
    expect(isSameColor("XANH", "XANH NHẠT")).toBe(false);
    expect(isSameColor("", "")).toBe(false);
  });

  it("builds a stable comparison key", () => {
    expect(colorKey("Xanh Đậm")).toBe("XANHDAM");
    expect(colorKey("  hồng  tím ")).toBe("HONGTIM");
  });
});

describe("product code + mime helpers", () => {
  it.each(["MR0AC6080", "MGKVX6310", "MMAC546", "MGAD506", "BG0SQ6083"])(
    "accepts real code '%s'",
    (code) => {
      expect(isProductCode(code)).toBe(true);
    },
  );

  it.each(["", "ABC", "1234", "IMG_1664", "MG0AD6051-MR0CV6068"])(
    "rejects '%s'",
    (value) => {
      expect(isProductCode(value)).toBe(false);
    },
  );

  it("maps mime types to kinds", () => {
    expect(mediaKindFromMimeType("video/mp4")).toBe("video");
    expect(mediaKindFromMimeType("image/jpeg")).toBe("image");
    expect(mediaKindFromMimeType("application/octet-stream")).toBeNull();
    expect(mediaKindFromMimeType(null)).toBeNull();
  });
});
