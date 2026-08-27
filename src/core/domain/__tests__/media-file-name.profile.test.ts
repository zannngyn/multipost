import { describe, expect, it } from "vitest";

import { findKnownCodes, parseMediaFileName } from "../media-file-name";
import type { MediaProfile } from "../media-profile";

/**
 * Phase 2: the parser per media profile. The `code-color-seq` behaviour is
 * covered by media-file-name.test.ts and must stay untouched — what is tested
 * here is that the OTHER three profiles keep a customer's photos usable.
 *
 * Names come from sample-data/5-ma-mau-file-listing.txt (real files) plus the
 * off-standard shapes listed in docs/05 sections 1.2-1.3.
 */

const CODES = ["MGKVX6310", "MGKAD6045", "MG0AC6017", "MR0AC6080", "MG0VS6111"];

function ok(name: string, profile?: MediaProfile | null, context?: Parameters<typeof parseMediaFileName>[2]) {
  const result = parseMediaFileName(name, profile, context);
  if (!result.ok) throw new Error(`expected ok parse for '${name}', got ${result.issue}`);
  return result.value;
}

describe("an absent profile behaves exactly like before phase 2", () => {
  it("parses the internal convention with no profile at all", () => {
    const value = ok("MR0AC6080-TRẮNG TIÊU-AI (1).jpg");
    expect(value).toMatchObject({
      productCode: "MR0AC6080",
      codeSource: "name-leading",
      color: "TRẮNG TIÊU",
      sequence: 1,
      extension: "jpg",
      isStrict: true,
    });
    expect(value.variants.aiGenerated).toBe(true);
  });

  it("still rejects a name whose code does not open it", () => {
    const result = parseMediaFileName("DV Huyền Thạch MGAC513 MMQD554.jpg");
    expect(result).toMatchObject({ ok: false, issue: "NO_PRODUCT_CODE" });
  });
});

describe("code-in-name — the code may sit anywhere", () => {
  const profile: MediaProfile = { kind: "code-in-name" };

  it("accepts the very name the internal convention rejects", () => {
    const value = ok("DV Huyền Thạch MGAC513 MMQD554.jpg", profile);
    expect(value.productCode).toBe("MGAC513");
    expect(value.codeSource).toBe("name-inner");
    expect(value.otherProductCodes).toEqual(["MMQD554"]);
    expect(value.warnings).toContain("MULTIPLE_PRODUCT_CODES");
  });

  it("recognises a code shape we have never seen, from the tenant's own sheet", () => {
    // `SP-001` matches no built-in pattern; only the sheet knows it is a code.
    const value = ok("anh chup san pham SP-001 ngay 12.8.jpg", profile, {
      knownCodes: ["SP-001", "SP-002"],
    });
    expect(value.productCode).toBe("SP-001");
    expect(value.codeSource).toBe("name-inner");
  });

  it("prefers the longest known code so a prefix does not steal the file", () => {
    const value = ok("IMG_SP-001B_final.jpg", profile, { knownCodes: ["SP-001", "SP-001B"] });
    expect(value.productCode).toBe("SP-001B");
  });

  it("does NOT warn about a missing colour or sequence — this profile promises neither", () => {
    const value = ok("MGKVX6310_IMG_1664.jpg", profile, { knownCodes: CODES });
    expect(value.productCode).toBe("MGKVX6310");
    expect(value.color).toBeNull();
    expect(value.sequence).toBeNull();
    expect(value.warnings).toEqual([]);
    // No warnings + a real extension = nothing to review. A customer's whole
    // catalog must not land on the "cần xem lại" list.
    expect(value.isStrict).toBe(true);
    expect(value.extraTokens.length).toBeGreaterThan(0);
  });

  it("finds a colour written mid-sentence, without the strict segments", () => {
    const value = ok("anh mau kem chup that MG0VS6111.jpeg", profile, { knownCodes: CODES });
    expect(value.productCode).toBe("MG0VS6111");
    expect(value.color).toBe("KEM");
  });

  it("rejects a name with no code at all, as a value with a Vietnamese reason", () => {
    const result = parseMediaFileName("IMG_1664.JPG", profile, { knownCodes: CODES });
    expect(result).toMatchObject({ ok: false, issue: "NO_PRODUCT_CODE" });
    if (result.ok) return;
    expect(result.detail).toContain("bảng tính");
  });
});

describe("folder-per-code / sheet-column — the code comes from outside the name", () => {
  it("uses the supplied code and reads only colour/sequence from the name", () => {
    const value = ok("KEM (13).png", { kind: "folder-per-code" }, { productCode: "mg0vs6111" });
    expect(value).toMatchObject({
      productCode: "MG0VS6111",
      codeSource: "external",
      color: "KEM",
      sequence: 13,
      extension: "png",
      isStrict: true,
    });
  });

  it("keeps a file whose name says nothing at all", () => {
    const value = ok("IMG_1664.JPG", { kind: "folder-per-code" }, { productCode: "MG0AC6017" });
    expect(value.productCode).toBe("MG0AC6017");
    expect(value.color).toBeNull();
    expect(value.colorRaw).toBeNull();
    expect(value.warnings).toEqual([]);
  });

  it("does not double-count a code that ALSO appears in the file name", () => {
    const value = ok(
      "MGKVX6310-Hồng (50).jpeg",
      { kind: "folder-per-code" },
      { productCode: "MGKVX6310" },
    );
    expect(value.productCode).toBe("MGKVX6310");
    expect(value.color).toBe("HỒNG");
    expect(value.sequence).toBe(50);
    expect(value.otherProductCodes).toEqual([]);
  });

  it("refuses, with the right sentence, when no code was supplied", () => {
    const folder = parseMediaFileName("IMG_1664.JPG", { kind: "folder-per-code" });
    expect(folder).toMatchObject({ ok: false, issue: "NO_PRODUCT_CODE" });
    if (!folder.ok) expect(folder.detail).toContain("thư mục");

    const sheet = parseMediaFileName("IMG_1664.JPG", { kind: "sheet-column" });
    expect(sheet).toMatchObject({ ok: false, issue: "NO_PRODUCT_CODE" });
    if (!sheet.ok) expect(sheet.detail).toContain("link ảnh");
  });

  it("still reports an empty name whatever the profile is", () => {
    for (const kind of ["sheet-column", "folder-per-code", "code-in-name"] as const) {
      expect(parseMediaFileName("   ", { kind }, { productCode: "X" })).toMatchObject({
        ok: false,
        issue: "EMPTY_NAME",
      });
    }
  });
});

describe("a tenant colour vocabulary drives the parse", () => {
  const profile: MediaProfile = {
    kind: "folder-per-code",
    colors: { canonical: ["Gỗ óc chó"], includeDefaults: false },
  };

  it("resolves the tenant's own colour", () => {
    const value = ok("go oc cho (2).jpg", profile, { productCode: "TU-01" });
    expect(value.color).toBe("Gỗ óc chó");
    expect(value.sequence).toBe(2);
  });

  it("treats a colour outside the tenant vocabulary as 'no colour', never an error", () => {
    const value = ok("XANH THAN (2).jpg", profile, { productCode: "TU-01" });
    expect(value.color).toBeNull();
    expect(value.warnings).toEqual([]);
    expect(value.extraTokens).toContain("XANH THAN");
  });
});

describe("findKnownCodes", () => {
  it("returns nothing for an empty vocabulary or a name without codes", () => {
    expect(findKnownCodes("IMG_1664", undefined)).toEqual([]);
    expect(findKnownCodes("IMG_1664", new Set(CODES))).toEqual([]);
  });

  it("ignores codes shorter than three characters (they match everything)", () => {
    expect(findKnownCodes("A1B2C3", ["A1"])).toEqual([]);
  });

  it("returns the matches in the order they appear", () => {
    expect(findKnownCodes("MG0VS6111 VA MGKAD6045", CODES)).toEqual([
      { code: "MG0VS6111", index: 0 },
      { code: "MGKAD6045", index: 13 },
    ]);
  });
});
