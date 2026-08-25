import { describe, expect, it, vi } from "vitest";

import { makeFieldMap, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type {
  DriveFile,
  DriveListing,
  DriveSource,
  ListDriveFilesDeepInput,
} from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import {
  detectMediaLinkColumn,
  makeProfileCatalogSource,
  scoreMediaProfiles,
} from "./profile-catalog-source";

/**
 * Phase 2 of the compatibility report: try all four media profiles on the same
 * sample and recommend one. This is the part that makes onboarding possible for
 * a tenant who does not know what shape their own Drive has.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

const COLUMNS = ["Mã sản phẩm", "Tên sản phẩm", "Tồn", "Link ảnh"];

function sheetOf(rows: Array<Record<string, string>>): SheetSnapshot {
  return {
    columns: COLUMNS,
    duplicateColumns: [],
    rows: rows.map((values, index) => ({ rowNumber: index + 2, values })),
  };
}

const row = (code: string, extra: Record<string, string> = {}) => ({
  "Mã sản phẩm": code,
  "Tên sản phẩm": "Giannal",
  Tồn: "10",
  ...extra,
});

function file(partial: Partial<DriveFile> & { id: string; name: string }): DriveFile {
  return {
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

function stubDrive(listing: DriveListing | null, flat: DriveFile[] = []): DriveSource {
  return {
    listFiles: async () => flat,
    download: async () => {
      throw new Error("download must not be called by the profiler");
    },
    ...(listing
      ? { listFilesDeep: async (_input: ListDriveFilesDeepInput) => listing }
      : {}),
  };
}

function run(input: {
  snapshot: SheetSnapshot;
  listing?: DriveListing | null;
  flat?: DriveFile[];
  fieldMap?: Parameters<typeof makeFieldMap>[0];
}) {
  const profiler = makeProfileCatalogSource({
    sheet: { readRows: async () => input.snapshot } as SheetSource,
    drive: stubDrive(input.listing ?? null, input.flat ?? []),
    logger: makeLogger(),
  });
  return profiler({
    tenantId: TENANT,
    spreadsheetId: "sheet",
    sheetName: "Mẫu 2026",
    driveFolderId: "folder",
    ...(input.fieldMap ? { fieldMap: makeFieldMap(input.fieldMap) } : {}),
  });
}

describe("scoreMediaProfiles — edge cases first", () => {
  it("recommends the default with confidence 0 when nothing matches", () => {
    const suggestion = scoreMediaProfiles({
      files: [file({ id: "f1", name: "IMG_1664.JPG" })],
      sheetCodes: ["MGKVX6310"],
      mediaLinks: [],
      mediaLinkColumn: null,
      recursive: false,
    });
    expect(suggestion.recommended).toBe("code-color-seq");
    expect(suggestion.confidence).toBe(0);
    expect(suggestion.candidates).toHaveLength(4);
  });

  it("marks a profile the sample cannot answer for, instead of scoring it 0 silently", () => {
    const suggestion = scoreMediaProfiles({
      files: [file({ id: "f1", name: "MGKVX6310-KEM (1).jpg" })],
      sheetCodes: ["MGKVX6310"],
      mediaLinks: [],
      mediaLinkColumn: null,
      recursive: false,
    });
    const sheetColumn = suggestion.candidates.find((c) => c.kind === "sheet-column");
    const folder = suggestion.candidates.find((c) => c.kind === "folder-per-code");
    expect(sheetColumn?.applicable).toBe(false);
    expect(sheetColumn?.note).toContain("cột");
    expect(folder?.applicable).toBe(false);
    expect(folder?.note).toContain("thư mục con");
  });

  it("scores 0 for every profile when the sheet has no codes at all", () => {
    const suggestion = scoreMediaProfiles({
      files: [file({ id: "f1", name: "MGKVX6310-KEM (1).jpg" })],
      sheetCodes: [],
      mediaLinks: [],
      mediaLinkColumn: null,
      recursive: true,
    });
    expect(suggestion.confidence).toBe(0);
    expect(suggestion.candidates.every((candidate) => candidate.score === 0)).toBe(true);
  });
});

describe("scoreMediaProfiles — picking the winner", () => {
  it("recommends folder-per-code for a customer who keeps one folder per code", () => {
    const suggestion = scoreMediaProfiles({
      files: [
        file({ id: "f1", name: "IMG_1664.JPG", folderPath: ["SP-001"], parentFolderId: "d1" }),
        file({ id: "f2", name: "IMG_1665.JPG", folderPath: ["SP-002"], parentFolderId: "d2" }),
      ],
      sheetCodes: ["SP-001", "SP-002"],
      mediaLinks: [],
      mediaLinkColumn: null,
      recursive: true,
    });

    expect(suggestion.recommended).toBe("folder-per-code");
    expect(suggestion.confidence).toBe(1);
    const winner = suggestion.candidates[0];
    expect(winner).toMatchObject({ kind: "folder-per-code", codesMatched: 2, score: 1, assets: 2 });
    // The internal convention finds nothing in these names — visibly zero.
    expect(suggestion.candidates.find((c) => c.kind === "code-color-seq")?.score).toBe(0);
  });

  it("recommends sheet-column when the link column answers for every code", () => {
    const suggestion = scoreMediaProfiles({
      files: [
        file({ id: "1AaaaaaaaaaaaaaaA", name: "1.jpg", parentFolderId: "root" }),
        file({ id: "1BbbbbbbbbbbbbbbB", name: "2.jpg", parentFolderId: "root" }),
      ],
      sheetCodes: ["SP-001", "SP-002"],
      mediaLinks: [
        { code: "SP-001", value: "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view" },
        { code: "SP-002", value: "https://drive.google.com/file/d/1BbbbbbbbbbbbbbbB/view" },
      ],
      mediaLinkColumn: "Link ảnh",
      recursive: true,
    });

    expect(suggestion.recommended).toBe("sheet-column");
    expect(suggestion.mediaLinkColumn).toBe("Link ảnh");
    expect(suggestion.confidence).toBe(1);
  });

  it("keeps the internal convention when it ties with code-in-name", () => {
    // Real names from sample-data/5-ma-mau-file-listing.txt: both profiles find
    // the same code, so the stricter one — the one already in use — wins.
    const suggestion = scoreMediaProfiles({
      files: [
        file({ id: "f1", name: "MR0AC6080-TRẮNG TIÊU-AI (1).jpg" }),
        file({ id: "f2", name: "MG0VS6111-NÂU (10).png" }),
      ],
      sheetCodes: ["MR0AC6080", "MG0VS6111"],
      mediaLinks: [],
      mediaLinkColumn: null,
      recursive: true,
    });

    expect(suggestion.recommended).toBe("code-color-seq");
    // A tie is honest about itself: half the winner's score.
    expect(suggestion.confidence).toBe(0.5);
  });

  it("prefers code-in-name when it genuinely matches more codes", () => {
    const suggestion = scoreMediaProfiles({
      files: [
        file({ id: "f1", name: "MR0AC6080-TRẮNG TIÊU-AI (1).jpg" }),
        file({ id: "f2", name: "DV Huyền Thạch MG0VS6111.jpg" }),
      ],
      sheetCodes: ["MR0AC6080", "MG0VS6111"],
      mediaLinks: [],
      mediaLinkColumn: null,
      recursive: true,
    });

    expect(suggestion.recommended).toBe("code-in-name");
    expect(suggestion.candidates[0].codesMatched).toBe(2);
    expect(suggestion.candidates[1]).toMatchObject({ kind: "code-color-seq", codesMatched: 1 });
    // Score 1.0 against a runner-up at 0.5: margin 0.5 -> confidence 0.75.
    // Full confidence is reserved for a winner nothing else comes close to.
    expect(suggestion.confidence).toBe(0.75);
  });
});

describe("detectMediaLinkColumn", () => {
  it("returns null when no column holds Drive links", () => {
    expect(detectMediaLinkColumn([])).toBeNull();
    expect(
      detectMediaLinkColumn([{ values: { "Mã sản phẩm": "SP-001", "Tên sản phẩm": "Váy" } }]),
    ).toBeNull();
  });

  it("finds the column whose cells are Drive links", () => {
    const rows = [
      {
        values: {
          "Mã sản phẩm": "SP-001",
          "Link ảnh": "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view",
        },
      },
      {
        values: {
          "Mã sản phẩm": "SP-002",
          "Link ảnh": "https://drive.google.com/drive/folders/1BbbbbbbbbbbbbbbB",
        },
      },
    ];
    expect(detectMediaLinkColumn(rows)).toBe("Link ảnh");
  });

  it("ignores a column where links are the exception", () => {
    const rows = [
      { values: { "Ghi chú": "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view" } },
      { values: { "Ghi chú": "hàng đặt riêng" } },
      { values: { "Ghi chú": "chờ mẫu" } },
    ];
    expect(detectMediaLinkColumn(rows)).toBeNull();
  });
});

describe("profileCatalogSource — the suggestion inside the report", () => {
  it("scores the four profiles on a recursive sample and reports the winner", async () => {
    const report = await run({
      snapshot: sheetOf([row("SP-001"), row("SP-002")]),
      listing: {
        files: [
          file({ id: "f1", name: "IMG_1664.JPG", folderPath: ["SP-001"], parentFolderId: "d1" }),
          file({ id: "f2", name: "IMG_1665.JPG", folderPath: ["SP-002"], parentFolderId: "d2" }),
        ],
        foldersVisited: 2,
        depthReached: 1,
        limitsHit: [],
      },
    });

    expect(report.mediaProfileSuggestion).toMatchObject({
      recommended: "folder-per-code",
      confidence: 1,
      recursive: true,
    });
    // The media section still measures compliance with the internal convention
    // — 0% here, which is exactly the problem the suggestion solves.
    expect(report.media?.nameRejected).toBe(2);
    // And the cross-check stays on the tenant's CURRENT profile (the default).
    expect(report.crossCheck?.postableNow).toBe(0);
  });

  it("suggests the detected link column as a warning the operator can act on", async () => {
    const report = await run({
      snapshot: sheetOf([
        row("SP-001", { "Link ảnh": "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view" }),
      ]),
      listing: {
        files: [file({ id: "1AaaaaaaaaaaaaaaA", name: "1.jpg", parentFolderId: "root" })],
        foldersVisited: 0,
        depthReached: 0,
        limitsHit: [],
      },
    });

    expect(report.mediaProfileSuggestion?.mediaLinkColumn).toBe("Link ảnh");
    expect(report.mediaProfileSuggestion?.recommended).toBe("sheet-column");
    expect(report.warnings.join(" ")).toContain("Link ảnh");
  });

  it("says the sample was not recursive when the Drive source cannot walk folders", async () => {
    const report = await run({
      snapshot: sheetOf([row("MGKVX6310")]),
      listing: null,
      flat: [file({ id: "f1", name: "MGKVX6310-KEM (1).jpg" })],
    });

    expect(report.mediaProfileSuggestion?.recursive).toBe(false);
    expect(
      report.mediaProfileSuggestion?.candidates.find((c) => c.kind === "folder-per-code"),
    ).toMatchObject({ applicable: false });
    expect(report.mediaProfileSuggestion?.recommended).toBe("code-color-seq");
  });

  it("warns that the sample is partial when the recursive listing hit a cap", async () => {
    const report = await run({
      snapshot: sheetOf([row("SP-001")]),
      listing: {
        files: [file({ id: "f1", name: "a.jpg", folderPath: ["SP-001"] })],
        foldersVisited: 1,
        depthReached: 1,
        limitsHit: ["MAX_FOLDERS"],
      },
    });

    expect(report.warnings.join(" ")).toContain("MAX_FOLDERS");
  });

  it("keeps working with no Drive folder at all — no media, no suggestion", async () => {
    const profiler = makeProfileCatalogSource({
      sheet: { readRows: async () => sheetOf([row("SP-001")]) } as SheetSource,
      logger: makeLogger(),
    });
    const report = await profiler({
      tenantId: TENANT,
      spreadsheetId: "sheet",
      sheetName: "Mẫu 2026",
    });
    expect(report.media).toBeNull();
    expect(report.mediaProfileSuggestion).toBeNull();
    expect(report.crossCheck).toBeNull();
  });

  it("uses the previewed profile for the cross-check, so 'postableNow' is honest", async () => {
    const profiler = makeProfileCatalogSource({
      sheet: { readRows: async () => sheetOf([row("SP-001")]) } as SheetSource,
      drive: stubDrive({
        files: [file({ id: "f1", name: "IMG_1664.JPG", folderPath: ["SP-001"] })],
        foldersVisited: 1,
        depthReached: 1,
        limitsHit: [],
      }),
      logger: makeLogger(),
    });

    const withDefault = await profiler({
      tenantId: TENANT,
      spreadsheetId: "sheet",
      sheetName: "Mẫu 2026",
      driveFolderId: "folder",
      fieldMap: makeFieldMap(MYSP_FIELD_MAP),
    });
    expect(withDefault.crossCheck?.postableNow).toBe(0);

    const withProfile = await profiler({
      tenantId: TENANT,
      spreadsheetId: "sheet",
      sheetName: "Mẫu 2026",
      driveFolderId: "folder",
      fieldMap: makeFieldMap(MYSP_FIELD_MAP),
      mediaProfile: { kind: "folder-per-code" },
    });
    expect(withProfile.crossCheck?.postableNow).toBe(1);
    expect(withProfile.crossCheck?.codesInBoth).toBe(1);
  });
});
