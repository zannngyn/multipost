import { describe, expect, it } from "vitest";

import {
  readFixtureDriveFiles,
  readFixtureSheetSnapshot,
} from "@/adapters/google/fixture-catalog-source";

import { MYSP_FIELD_MAP } from "../catalog-field-map";
import { resolveMedia, type MediaSourceFile } from "../media-resolver";
import { parseSheetRow } from "../product";

/**
 * The four profiles against the REAL data of docs/05: 5,497 Drive names and the
 * 299 sheet codes of tab "Mẫu 2026" (sample-data/). Fixtures are read through
 * the adapter that already owns them — a test may cross layers, shipped code
 * may not (dependency-cruiser excludes *.test.ts).
 *
 * The numbers below are assertions about the DATA, not about a formatting
 * choice: if a parser change moves them, something real changed.
 */

const files = readFixtureDriveFiles() as MediaSourceFile[];
const snapshot = readFixtureSheetSnapshot();

const sheetCodes = snapshot.rows
  .map((row) => parseSheetRow(row.rowNumber, row.values, MYSP_FIELD_MAP))
  .filter((parsed) => parsed.ok)
  .map((parsed) => (parsed.ok ? parsed.value.content.code : ""));

function codesOf(assets: readonly { productCode: string }[]): Set<string> {
  return new Set(assets.map((asset) => asset.productCode));
}

describe("the real folder — 5,497 files", () => {
  it("has the shape docs/05 measured", () => {
    expect(files.length).toBeGreaterThan(5000);
    expect(new Set(sheetCodes).size).toBeGreaterThan(250);
  });

  it("code-color-seq (the default) keeps most files and reports the rest", () => {
    const result = resolveMedia({ files, knownCodes: sheetCodes });

    // ~71.8% strict compliance, 28.2% deviations (docs/05 section 1.2): most
    // deviations are still USABLE — only the ones with no leading code are
    // dropped, and every one of them is a reported value.
    expect(result.assets.length).toBeGreaterThan(files.length * 0.9);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected.every((issue) => issue.detail.length > 0)).toBe(true);
    expect(result.assets.length + result.rejected.length).toBe(files.length);

    // Colours still resolve on the real spellings.
    const colours = new Set(result.assets.map((asset) => asset.color).filter(Boolean));
    expect(colours.has("XANH THAN")).toBe(true);
    expect(colours.has("TRẮNG")).toBe(true);
  });

  it("code-in-name recovers files the internal convention drops, and drops none of its own", () => {
    const strict = resolveMedia({ files, knownCodes: sheetCodes });
    const lenient = resolveMedia({
      files,
      profile: { kind: "code-in-name" },
      knownCodes: sheetCodes,
    });

    expect(lenient.assets.length).toBeGreaterThan(strict.assets.length);
    expect(lenient.rejected.length).toBeLessThan(strict.rejected.length);

    // Every code that EXISTS IN THE SHEET keeps its photos. The two profiles do
    // disagree about outfit sets (`MG0AD6051-MR0CV6068-AI.png`, 739 real
    // files): the strict one takes the leading code, `code-in-name` prefers the
    // code the sheet actually has — which is the point of feeding it the
    // tenant's own codes.
    const known = new Set(sheetCodes);
    const lenientCodes = codesOf(lenient.assets);
    for (const code of codesOf(strict.assets)) {
      if (!known.has(code)) continue;
      expect(lenientCodes.has(code)).toBe(true);
    }
  });

  it("no colour vocabulary at all still keeps every file — only the colour is lost", () => {
    const withColors = resolveMedia({ files, knownCodes: sheetCodes });
    const withoutColors = resolveMedia({
      files,
      profile: { kind: "code-in-name", colors: { canonical: [], includeDefaults: false } },
      knownCodes: sheetCodes,
    });

    expect(withoutColors.assets.length).toBeGreaterThanOrEqual(withColors.assets.length);
    expect(withoutColors.assets.every((asset) => asset.color === null)).toBe(true);
    // "Không phân màu" is not an error: nothing extra is rejected for it.
    expect(withoutColors.rejected.length).toBeLessThanOrEqual(withColors.rejected.length);
  });

  it("folder-per-code reads the same catalog when the SAME files are foldered by code", () => {
    // The customer layout of the same shop: photos moved into `MÃ/` folders and
    // renamed to whatever the camera produced.
    const strict = resolveMedia({ files, knownCodes: sheetCodes });
    const foldered: MediaSourceFile[] = strict.assets.map((asset, index) => ({
      id: asset.driveFileId,
      name: `IMG_${index}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      modifiedTime: asset.modifiedTime,
      parentFolderId: `folder-${asset.productCode}`,
      folderPath: [asset.productCode],
    }));

    const result = resolveMedia({
      files: foldered,
      profile: { kind: "folder-per-code" },
      knownCodes: sheetCodes,
    });

    expect(result.assets.length).toBe(foldered.length);
    expect(result.rejected).toEqual([]);
    expect(codesOf(result.assets)).toEqual(codesOf(strict.assets));
  });

  it("sheet-column attaches by link with no naming convention at all", () => {
    const sample = files.slice(0, 50).map((file, index) => ({
      ...file,
      id: `1FileId${index.toString().padStart(10, "0")}`,
      parentFolderId: "root",
    }));
    const links = sample.map((file, index) => ({
      code: sheetCodes[index % sheetCodes.length],
      value: `https://drive.google.com/file/d/${file.id}/view`,
    }));

    const result = resolveMedia({
      files: sample,
      profile: { kind: "sheet-column" },
      knownCodes: sheetCodes,
      mediaLinks: links,
    });

    expect(result.assets).toHaveLength(sample.length);
    expect(result.assets.every((asset) => asset.color === null)).toBe(true);
    expect(result.rejected).toEqual([]);
  });
});
