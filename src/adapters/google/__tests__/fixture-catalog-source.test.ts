import { describe, expect, it } from "vitest";

import { parseMediaFileName } from "@/core/domain/media-file-name";
import { parseSheetRow, SHEET_COLUMNS } from "@/core/domain/product";

import {
  parseCsv,
  readFixtureDriveFiles,
  readFixtureSheetSnapshot,
} from "../fixture-catalog-source";

/**
 * Runs the parser over the WHOLE real sample: 5,497 Drive names + the 301-row
 * sheet export. Numbers are printed so a reviewer can compare them with docs/05,
 * and asserted loosely so the suite fails when parsing regresses, not when one
 * new file appears.
 */

describe("fixture sources", () => {
  it("reads the sub-folders out of the listing and keeps every file", () => {
    const files = readFixtureDriveFiles();
    expect(files).toHaveLength(5497);
    expect(new Set(files.map((file) => file.id)).size).toBe(files.length);
    expect(files.some((file) => file.name.trim() === "Nghệ sĩ")).toBe(false);
  });

  it("parses quoted CSV fields that contain commas and newlines", () => {
    const grid = parseCsv('a,b\n"x,1","line1\nline2"\n"say ""hi""",z\n');
    expect(grid).toEqual([
      ["a", "b"],
      ["x,1", "line1\nline2"],
      ['say "hi"', "z"],
    ]);
  });

  it("addresses sheet columns by name, dropping blank headers", () => {
    const snapshot = readFixtureSheetSnapshot();
    expect(snapshot.columns).toContain(SHEET_COLUMNS.code);
    expect(snapshot.columns).toContain(SHEET_COLUMNS.stock);
    expect(snapshot.columns).toContain(SHEET_COLUMNS.note);
    expect(snapshot.columns).not.toContain("");
    expect(snapshot.rows[0].rowNumber).toBe(2);
  });
});

describe("parser over the whole real Drive listing", () => {
  it("reports naming compliance without rejecting the folder", () => {
    const files = readFixtureDriveFiles();

    const issueCounts = new Map<string, number>();
    const warningCounts = new Map<string, number>();
    const extensionCounts = new Map<string, number>();
    const failedSamples: string[] = [];
    const codes = new Set<string>();
    let strict = 0;
    let briefShaped = 0;
    let ok = 0;
    let videos = 0;
    let missingColor = 0;

    for (const file of files) {
      const result = parseMediaFileName(file.name);
      if (!result.ok) {
        issueCounts.set(result.issue, (issueCounts.get(result.issue) ?? 0) + 1);
        if (failedSamples.length < 10) failedSamples.push(`${result.issue}: ${result.raw}`);
        continue;
      }
      ok += 1;
      codes.add(result.value.productCode);
      if (result.value.isStrict) strict += 1;
      // docs/05 counted `CODE-<anything> (n).ext` as compliant, i.e. it accepted
      // a colour slot it could not map. Counted here too, for comparison.
      if (
        result.value.colorRaw !== null &&
        result.value.sequence !== null &&
        result.value.extension !== null &&
        !result.value.warnings.includes("UNKNOWN_EXTENSION") &&
        !result.value.warnings.includes("EXTENSION_WITHOUT_DOT") &&
        !result.value.warnings.includes("LEADING_TRAILING_WHITESPACE")
      ) {
        briefShaped += 1;
      }
      if (result.value.kind === "video") videos += 1;
      if (result.value.color === null) missingColor += 1;
      const ext = result.value.extension ?? "(none)";
      extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
      for (const warning of result.value.warnings) {
        warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
      }
    }

    const table = (entries: Map<string, number>) =>
      [...entries.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}=${count}`);

    // Printed on purpose: this is the evidence for the sync report.
    console.log(
      [
        "",
        "--- Drive listing parse report (sample-data/drive-file-listing.txt) ---",
        `total files          : ${files.length}`,
        `parsed ok            : ${ok} (${((ok / files.length) * 100).toFixed(1)}%)`,
        `  of which strict    : ${strict} (${((strict / files.length) * 100).toFixed(1)}%)`,
        `  docs/05 "compliant": ${briefShaped} (${((briefShaped / files.length) * 100).toFixed(1)}%)`,
        `rejected             : ${files.length - ok}`,
        `distinct codes       : ${codes.size}`,
        `videos               : ${videos}`,
        `no colour in name    : ${missingColor}`,
        `rejections           : ${table(issueCounts).join(" · ")}`,
        `warnings             : ${table(warningCounts).join(" · ")}`,
        `extensions           : ${table(extensionCounts).join(" · ")}`,
        "first 10 rejected file names:",
        ...failedSamples.map((sample) => `  - ${sample}`),
        "",
      ].join("\n"),
    );

    // docs/05: 186 codes, ~5,497 files, only a small tail is unusable.
    expect(ok).toBeGreaterThan(5000);
    expect(codes.size).toBeGreaterThanOrEqual(180);
    expect(issueCounts.get("NO_PRODUCT_CODE") ?? 0).toBeGreaterThan(0);
    expect(files.length - ok).toBeLessThan(500);
  });

  it("parses every sheet row it can and reports the rest", () => {
    const snapshot = readFixtureSheetSnapshot();
    const issues = new Map<string, number>();
    const samples: string[] = [];
    let ok = 0;
    let empty = 0;

    for (const row of snapshot.rows) {
      const hasValue = Object.values(row.values).some((value) => value.trim().length > 0);
      if (!hasValue) {
        empty += 1;
        continue;
      }
      const parsed = parseSheetRow(row.rowNumber, row.values);
      if (parsed.ok) {
        ok += 1;
        continue;
      }
      issues.set(parsed.issue, (issues.get(parsed.issue) ?? 0) + 1);
      if (samples.length < 5) samples.push(`${parsed.issue}: ${parsed.detail}`);
    }

    console.log(
      [
        "",
        "--- Sheet snapshot parse report (tab 'Mẫu 2026') ---",
        `columns              : ${snapshot.columns.length}`,
        `duplicate columns    : ${snapshot.duplicateColumns.join(", ") || "(none)"}`,
        `data rows            : ${snapshot.rows.length} (blank: ${empty})`,
        `products parsed      : ${ok}`,
        `rows rejected        : ${[...issues.entries()].map(([k, v]) => `${k}=${v}`).join(" · ") || "(none)"}`,
        ...samples.map((sample) => `  - ${sample}`),
        "",
      ].join("\n"),
    );

    // docs/05 section 2.1: 301 rows carry a code.
    expect(ok).toBeGreaterThanOrEqual(295);
  });
});
