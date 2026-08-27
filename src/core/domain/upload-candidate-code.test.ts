import { describe, expect, it } from "vitest";

import { detectUploadProductCode } from "./upload-candidate-code";

describe("detectUploadProductCode", () => {
  it("reads the code, colour and sequence when the name follows the convention", () => {
    const result = detectUploadProductCode("BG0SQ6083-XANH THAN (2).jpg");
    expect(result).toMatchObject({
      status: "parsed",
      productCode: "BG0SQ6083",
      color: "XANH THAN",
      sequence: 2,
    });
  });

  it("keeps -AI as a marker, never part of the code (spec 5.2)", () => {
    const result = detectUploadProductCode("BG0SQ6083-AI (5).png");
    expect(result).toMatchObject({ status: "parsed", productCode: "BG0SQ6083", sequence: 5 });
  });

  it("reads a code written with spaces around the dash", () => {
    expect(detectUploadProductCode("BG0SQ6083 - AI (5).png")).toMatchObject({
      status: "parsed",
      productCode: "BG0SQ6083",
    });
  });

  it("reads a bare code with no suffix at all", () => {
    expect(detectUploadProductCode("BG0SQ6083.png")).toMatchObject({
      status: "parsed",
      productCode: "BG0SQ6083",
    });
  });

  it("falls back to the stem before the first dash when the parser finds no code", () => {
    // XYZ9999 does not match the internal code shape, so the parser refuses it.
    // The candidate layer still offers it, so the screen can prefill the input.
    const result = detectUploadProductCode("XYZ9999-AI.png");
    expect(result).toMatchObject({ status: "candidate", candidateCode: "XYZ9999" });
  });

  it("offers the whole stem as a candidate when the name holds no dash", () => {
    expect(detectUploadProductCode("IMG_8821.png")).toMatchObject({
      status: "candidate",
      candidateCode: "IMG_8821",
    });
  });

  it("uppercases and trims a candidate so the catalog lookup is case-insensitive", () => {
    expect(detectUploadProductCode("  xyz9999 - ai.png")).toMatchObject({
      status: "candidate",
      candidateCode: "XYZ9999",
    });
  });

  it("returns none for a name with nothing usable in it", () => {
    expect(detectUploadProductCode("   .png")).toMatchObject({ status: "none" });
    expect(detectUploadProductCode("")).toMatchObject({ status: "none" });
  });

  it("reads a tenant code containing a dash through knownCodes, never cutting it", () => {
    const result = detectUploadProductCode(
      "SP-001-AI (1).png",
      { kind: "code-in-name" },
      { knownCodes: new Set(["SP-001"]) },
    );
    expect(result).toMatchObject({ status: "parsed", productCode: "SP-001" });
  });

  it("never throws on a malformed input", () => {
    expect(() => detectUploadProductCode(undefined as unknown as string)).not.toThrow();
  });
});
