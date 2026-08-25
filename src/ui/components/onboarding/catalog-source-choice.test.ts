import { describe, expect, it } from "vitest";

import {
  CATALOG_FILE_EXPORT_STEPS,
  CATALOG_FILE_RULE,
  CATALOG_SOURCE_CHOICES,
  activeSourceChoice,
  describeDelimiter,
  describeUploadedFile,
  isSourceReady,
  missingSourceReason,
} from "@/ui/components/onboarding/catalog-source-choice";
import type { CatalogSource } from "@/ui/schemas/catalog.schema";

function source(overrides: Partial<CatalogSource> = {}): CatalogSource {
  return {
    driveFolderId: "folder-1",
    spreadsheetId: "sheet-1",
    sheetName: "Mẫu 2026",
    driveFolderUrl: "https://drive.google.com/drive/folders/folder-1",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
    fieldMap: null,
    stockPolicy: null,
    mediaProfile: null,
    textSource: null,
    ...overrides,
  };
}

const uploaded = {
  kind: "file",
  storageKey: "catalog/t1/abc",
  fileName: "bang-gia-2026.csv",
  contentType: "text/csv",
  sizeBytes: 248_000,
  uploadedAt: "2026-08-24T07:32:07.000Z",
} as const;

/**
 * Edge cases first (CLAUDE.md technical rule 1). The two that matter are both
 * about a MISSING value being read as a decision: an absent `textSource` means
 * "Google tab", never "no source", and a row that exists is not the same as a
 * step that is finished.
 */
describe("activeSourceChoice", () => {
  it("reads an absent config as the Google tab, never as a file", () => {
    expect(activeSourceChoice(source())).toBe("google_sheet");
    expect(activeSourceChoice(source({ textSource: { kind: "google_sheet" } }))).toBe(
      "google_sheet",
    );
    expect(activeSourceChoice(null)).toBe("google_sheet");
    expect(activeSourceChoice(undefined)).toBe("google_sheet");
  });

  it("reads a stored file as the file option", () => {
    expect(activeSourceChoice(source({ textSource: uploaded }))).toBe("file");
  });
});

describe("isSourceReady", () => {
  it("is finished for a tenant with an uploaded file and NO Google coordinates", () => {
    // The whole point of phase 3: this customer has no spreadsheet at all.
    const fileOnly = source({
      driveFolderId: "",
      spreadsheetId: "",
      sheetName: "",
      textSource: uploaded,
    });
    expect(isSourceReady(fileOnly)).toBe(true);
    expect(missingSourceReason(fileOnly)).toBeNull();
  });

  it("is NOT finished for a Google tenant who has a row but no spreadsheet", () => {
    // A row exists — a "does the row exist" check would wave this through into a
    // step 2 that cannot read anything.
    const half = source({ spreadsheetId: "   " });
    expect(isSourceReady(half)).toBe(false);
    expect(missingSourceReason(half)).toContain("Google Sheet");
  });

  it("is not finished when nothing is configured at all", () => {
    expect(isSourceReady(null)).toBe(false);
    expect(missingSourceReason(null)).toContain("Chưa khai nguồn dữ liệu");
  });

  it("is finished for an ordinary Google tenant", () => {
    expect(isSourceReady(source())).toBe(true);
  });
});

describe("the two options are presented as equals", () => {
  it("offers exactly the two the system can actually read", () => {
    expect(CATALOG_SOURCE_CHOICES.map((choice) => choice.kind)).toEqual(["google_sheet", "file"]);
  });

  it("describes each by who it fits, never by rank", () => {
    for (const choice of CATALOG_SOURCE_CHOICES) {
      expect(choice.summary.length).toBeGreaterThan(0);
      expect(choice.fitFor).toMatch(/^Hợp khi/);
      // "nâng cao", "dự phòng", "tạm thời" would all file one option under the
      // other. The CSV path is somebody's only option, not a consolation.
      expect(`${choice.label} ${choice.summary} ${choice.fitFor}`).not.toMatch(
        /nâng cao|dự phòng|tạm thời|hạn chế/i,
      );
    }
  });

  it("states the CSV-only rule and how to export, before any picker", () => {
    expect(CATALOG_FILE_RULE).toMatch(/chỉ đọc file CSV/);
    expect(CATALOG_FILE_RULE).toMatch(/\.xlsx/);
    const steps = CATALOG_FILE_EXPORT_STEPS.join(" ");
    expect(steps).toMatch(/Lưu dưới dạng/);
    expect(steps).toMatch(/UTF-8/);
    // The header-row rule belongs here too: the server refuses a file without
    // one, and that refusal is avoidable if it is said first.
    expect(steps).toMatch(/tên cột/i);
  });
});

describe("describeUploadedFile", () => {
  it("answers 'đang đọc file nào, tải lên lúc nào'", () => {
    const line = describeUploadedFile(uploaded);
    expect(line?.fileName).toBe("bang-gia-2026.csv");
    expect(line?.uploadedAt).not.toBeNull();
    expect(line?.sizeLabel).toBe("248 KB");
  });

  it("degrades rather than inventing a time the server did not send", () => {
    const line = describeUploadedFile({ ...uploaded, uploadedAt: null });
    expect(line?.fileName).toBe("bang-gia-2026.csv");
    expect(line?.uploadedAt).toBeNull();
  });

  it("has nothing to say about a Google tab", () => {
    expect(describeUploadedFile({ kind: "google_sheet" })).toBeNull();
    expect(describeUploadedFile(null)).toBeNull();
  });
});

describe("describeDelimiter", () => {
  it("says so loudly when the separator was a GUESS", () => {
    const text = describeDelimiter(";", true);
    expect(text).toMatch(/tự nhận diện/);
    // A wrong guess looks like shifted columns; the way out has to be there.
    expect(text).toMatch(/lệch/);
  });

  it("states it plainly when it was not guessed", () => {
    const text = describeDelimiter(",", false);
    expect(text).toMatch(/dấu phẩy/);
    expect(text).not.toMatch(/tự nhận diện/);
  });

  it("names a tab instead of printing an invisible character", () => {
    expect(describeDelimiter("\t", false)).toContain("Tab");
  });

  it("says nothing when the reader reported no separator", () => {
    expect(describeDelimiter(null, true)).toBeNull();
    expect(describeDelimiter("", false)).toBeNull();
  });
});
