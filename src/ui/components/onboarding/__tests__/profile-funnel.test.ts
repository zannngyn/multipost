import { describe, expect, it } from "vitest";

import { headlineNumber, profileFunnel } from "@/ui/components/onboarding/profile-funnel";
import type { CatalogProfileReport } from "@/ui/schemas/catalog-mapping.schema";

/**
 * The numbers below are the real survey (docs/05 §4): 299 rows, 20 postable.
 * The point of the test is that the losses ADD UP on screen — an operator who
 * cannot follow 299 down to 20 will not trust either end of it.
 */
function report(overrides: Partial<CatalogProfileReport> = {}): CatalogProfileReport {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    spreadsheetId: "sheet-1",
    sheetName: "Mẫu 2026",
    driveFolderId: "folder-1",
    stockPolicyMode: "numeric",
    sheet: {
      columns: ["Mã sản phẩm", "Tên sản phẩm", "Tồn"],
      duplicateColumns: [],
      totalRows: 310,
      emptyRows: 11,
      productsParsed: 299,
      rowsRejected: 4,
      rejectionGroups: [],
      duplicateCodes: 2,
      conflictingCodes: [],
    },
    fieldMap: {
      fieldMap: {
        code: "Mã sản phẩm",
        name: "Tên sản phẩm",
        description: null,
        category: null,
        season: null,
        stock: "Tồn",
        note: null,
        colors: null,
      },
      source: "suggested",
      fields: [],
      unmappedColumns: [],
      priceLikeColumns: [],
      issues: [],
    },
    media: {
      sampled: 1000,
      cap: 1000,
      capped: true,
      nameParsed: 718,
      nameRejected: 282,
      parseRate: 0.718,
      strictNames: 700,
      withoutExtension: 60,
      duplicateNames: 3,
      distinctCodes: 120,
      issueGroups: [],
    },
    // The four layouts, scored on the same sample — `code-color-seq` wins here
    // because these fixtures are the internal company's own Drive.
    mediaProfileSuggestion: {
      recommended: "code-color-seq",
      confidence: 0.4,
      candidates: [
        {
          kind: "code-color-seq",
          label: "Tên file theo mẫu MÃ-Màu (số).ext",
          applicable: true,
          note: null,
          assets: 718,
          rejected: 282,
          codesMatched: 120,
          score: 0.401,
        },
        {
          kind: "sheet-column",
          label: "Link ảnh nằm trên một cột của bảng tính",
          applicable: false,
          note: "Chưa tìm thấy cột nào chứa link Drive trên bảng tính — chọn cột link ảnh rồi chạy lại kiểm tra.",
          assets: 0,
          rejected: 0,
          codesMatched: 0,
          score: 0,
        },
      ],
      mediaLinkColumn: null,
      recursive: true,
    },
    crossCheck: {
      codesInSheet: 299,
      codesInDrive: 120,
      codesInBoth: 45,
      codesOnlyInSheet: 254,
      codesOnlyInDrive: 75,
      blockedByInventory: 25,
      postableNow: 20,
      postableSample: ["MGKVX6310"],
      stockCheckSkipped: false,
    },
    topIssues: [],
    warnings: [],
    ...overrides,
  };
}

describe("headlineNumber", () => {
  it("is the postable count when the cross-check ran", () => {
    expect(headlineNumber(report())).toEqual({
      value: 20,
      unavailableReason: null,
      stockCheckSkipped: false,
    });
  });

  it("carries the skipped-stock flag so the screen can mark the number optimistic", () => {
    const withSkip = report({
      crossCheck: { ...report().crossCheck!, stockCheckSkipped: true },
    });

    expect(headlineNumber(withSkip).stockCheckSkipped).toBe(true);
  });

  it("refuses to invent a number when no Drive folder was given, and says why", () => {
    const noDrive = headlineNumber(report({ crossCheck: null, media: null, driveFolderId: null }));

    expect(noDrive.value).toBeNull();
    expect(noDrive.unavailableReason).toContain("Chưa khai thư mục ảnh");
  });

  it("tells 'chưa khai' apart from 'không đọc được'", () => {
    const unreadable = headlineNumber(report({ crossCheck: null, media: null }));

    expect(unreadable.value).toBeNull();
    expect(unreadable.unavailableReason).toContain("Không đọc được");
  });
});

describe("profileFunnel", () => {
  it("walks rows -> products -> media -> matched -> postable and names each loss", () => {
    const stages = profileFunnel(report());

    expect(stages.map((stage) => stage.key)).toEqual([
      "rows",
      "products",
      "media",
      "matched",
      "postable",
    ]);
    expect(stages[0]?.loss).toContain("11 dòng trống");
    expect(stages[1]?.loss).toContain("4 dòng bị loại");
    expect(stages[1]?.loss).toContain("2 dòng trùng mã");
    expect(stages[2]?.loss).toContain("72%");
    expect(stages[3]?.loss).toContain("254 mã có dòng nhưng chưa có ảnh");
    expect(stages[4]?.loss).toContain("25 mã bị chặn");
    expect(stages[4]?.loss).toContain("ô tồn trống");
    expect(stages[4]?.value).toBe(20);
  });

  it("omits the Drive stages entirely rather than showing a zero nobody may act on", () => {
    const stages = profileFunnel(report({ media: null, crossCheck: null }));

    expect(stages.map((stage) => stage.key)).toEqual(["rows", "products"]);
  });

  it("drops 'ô tồn trống' from the causes when the tenant turned the stock gate off", () => {
    // Sending an operator to fix a cell that is no longer read is the same class
    // of lie as claiming nothing blocks at all.
    const skipped = report({
      stockPolicyMode: "disabled",
      crossCheck: { ...report().crossCheck!, stockCheckSkipped: true },
    });
    const loss = profileFunnel(skipped)[4]?.loss ?? "";

    expect(loss).toContain("HẾT HÀNG");
    expect(loss).toContain("hai dòng cùng mã");
    expect(loss).not.toContain("ô tồn trống");
  });

  it("leaves a stage's loss null when nothing was lost there", () => {
    const clean = report({
      sheet: { ...report().sheet, emptyRows: 0, rowsRejected: 0, duplicateCodes: 0 },
    });

    expect(profileFunnel(clean)[0]?.loss).toBeNull();
    expect(profileFunnel(clean)[1]?.loss).toBeNull();
  });
});
