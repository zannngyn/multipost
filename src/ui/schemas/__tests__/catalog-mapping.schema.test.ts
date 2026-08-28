import { describe, expect, it } from "vitest";

import {
  CatalogFieldMapSchema,
  CatalogProfileResponseSchema,
  MEDIA_PROFILE_KINDS,
  MediaProfileConfigSchema,
  mediaConfidenceBand,
  mediaProfileKeepsColor,
  mediaProfileNeedsLinkColumn,
} from "../catalog-mapping.schema";

/**
 * These schemas mirror core types the UI may not import (docs/07 §2), and the
 * media half was added because the mirror had already drifted once: the server
 * computed `mediaProfileSuggestion` and `z.object` stripped it on the way in, so
 * the screen was blind to a whole feature with nothing failing anywhere.
 *
 * The point of the first test is exactly that: a stripped key is invisible, so
 * it has to be asserted rather than looked at.
 */

const SUGGESTION = {
  recommended: "folder-per-code",
  confidence: 0.62,
  candidates: [
    {
      kind: "folder-per-code",
      label: "Mỗi mã sản phẩm một thư mục con trên Drive",
      applicable: true,
      note: null,
      assets: 412,
      rejected: 12,
      codesMatched: 187,
      score: 0.625,
    },
    {
      kind: "sheet-column",
      label: "Link ảnh nằm trên một cột của bảng tính",
      applicable: false,
      note: "Chưa tìm thấy cột nào chứa link Drive trên bảng tính.",
      assets: 0,
      rejected: 0,
      codesMatched: 0,
      score: 0,
    },
  ],
  mediaLinkColumn: null,
  recursive: true,
};

function profileResponse(overrides: Record<string, unknown> = {}) {
  return {
    state: "profiled",
    report: {
      tenantId: "00000000-0000-0000-0000-000000000001",
      spreadsheetId: "sheet-1",
      sheetName: "Mẫu 2026",
      driveFolderId: "folder-1",
      stockPolicyMode: "numeric",
      sheet: {
        columns: ["Mã sản phẩm"],
        duplicateColumns: [],
        totalRows: 10,
        emptyRows: 0,
        productsParsed: 9,
        rowsRejected: 1,
        rejectionGroups: [],
        duplicateCodes: 0,
        conflictingCodes: [],
      },
      fieldMap: {
        fieldMap: {
          code: "Mã sản phẩm",
          name: null,
          description: null,
          category: null,
          season: null,
          stock: null,
          note: null,
          colors: null,
          mediaLink: null,
        },
        source: "suggested",
        fields: [],
        unmappedColumns: [],
        priceLikeColumns: [],
        issues: [],
      },
      media: {
        sampled: 100,
        cap: 1000,
        capped: false,
        nameParsed: 80,
        nameRejected: 20,
        parseRate: 0.8,
        strictNames: 70,
        withoutExtension: 0,
        duplicateNames: 0,
        distinctCodes: 30,
        issueGroups: [],
      },
      mediaProfileSuggestion: SUGGESTION,
      crossCheck: null,
      topIssues: [],
      warnings: [],
      ...overrides,
    },
  };
}

describe("CatalogProfileReportSchema — the media suggestion", () => {
  it("keeps `mediaProfileSuggestion` instead of stripping it", () => {
    const parsed = CatalogProfileResponseSchema.parse(profileResponse());

    expect(parsed.state).toBe("profiled");
    if (parsed.state !== "profiled") return;
    expect(parsed.report.mediaProfileSuggestion?.recommended).toBe("folder-per-code");
    // The evidence, not just the winner: without the candidates the screen can
    // only say "tin tôi đi".
    expect(parsed.report.mediaProfileSuggestion?.candidates).toHaveLength(2);
    expect(parsed.report.mediaProfileSuggestion?.candidates[0]?.codesMatched).toBe(187);
  });

  it("accepts the null the server sends when Drive could not be read", () => {
    const parsed = CatalogProfileResponseSchema.parse(
      profileResponse({ media: null, mediaProfileSuggestion: null }),
    );

    if (parsed.state !== "profiled") throw new Error("expected a profiled report");
    expect(parsed.report.mediaProfileSuggestion).toBeNull();
  });

  it("refuses a report that omits the key entirely", () => {
    // A MISSING key is a server that does not answer the question — different
    // from `null`, which answers "không đọc được thư mục ảnh".
    const { mediaProfileSuggestion: _omitted, ...report } = profileResponse().report;

    expect(
      CatalogProfileResponseSchema.safeParse({ state: "profiled", report }).success,
    ).toBe(false);
  });

  it("refuses a layout name nobody implements", () => {
    const broken = profileResponse({
      mediaProfileSuggestion: { ...SUGGESTION, recommended: "whatever" },
    });

    expect(CatalogProfileResponseSchema.safeParse(broken).success).toBe(false);
  });
});

describe("CatalogFieldMapSchema — the link slot", () => {
  const BASE = {
    code: "Mã",
    name: "Tên",
    description: null,
    category: null,
    season: null,
    stock: null,
    note: null,
    colors: null,
  };

  it("still parses a map stored before the slot existed", () => {
    expect(CatalogFieldMapSchema.parse(BASE).mediaLink).toBeUndefined();
  });

  it("carries a declared link column through", () => {
    expect(CatalogFieldMapSchema.parse({ ...BASE, mediaLink: "Link ảnh" }).mediaLink).toBe(
      "Link ảnh",
    );
  });
});

describe("MediaProfileConfigSchema", () => {
  it("accepts each of the four kinds and nothing else", () => {
    for (const kind of MEDIA_PROFILE_KINDS) {
      expect(MediaProfileConfigSchema.parse({ kind }).kind).toBe(kind);
    }
    expect(MediaProfileConfigSchema.safeParse({ kind: "code-first" }).success).toBe(false);
  });

  it("keeps a colour vocabulary rather than dropping it on the floor", () => {
    const parsed = MediaProfileConfigSchema.parse({
      kind: "code-color-seq",
      colors: { canonical: ["XANH THAN"], aliases: { XANHTHAN: "XANH THAN" } },
    });

    expect(parsed.colors?.aliases).toEqual({ XANHTHAN: "XANH THAN" });
  });
});

describe("what each layout costs", () => {
  it("names the one layout that needs a link column", () => {
    expect(MEDIA_PROFILE_KINDS.filter(mediaProfileNeedsLinkColumn)).toEqual(["sheet-column"]);
  });

  it("names the one layout that still reads a colour off the file name", () => {
    // The trade-off the screen has to shout about: everything except
    // `code-color-seq` loses the colour, and `sheet-column` loses it completely.
    expect(MEDIA_PROFILE_KINDS.filter(mediaProfileKeepsColor)).toEqual(["code-color-seq"]);
  });
});

describe("mediaConfidenceBand", () => {
  it("treats a nonsense number as 'not scored' instead of 'confident'", () => {
    expect(mediaConfidenceBand(Number.NaN)).toBe("none");
    expect(mediaConfidenceBand(-1)).toBe("none");
    expect(mediaConfidenceBand(0)).toBe("none");
  });

  it("splits the rest into three bands", () => {
    expect(mediaConfidenceBand(0.2)).toBe("low");
    expect(mediaConfidenceBand(0.5)).toBe("medium");
    expect(mediaConfidenceBand(0.8)).toBe("high");
    expect(mediaConfidenceBand(1)).toBe("high");
  });
});

/**
 * Onboarding phase 3 — a report produced from an UPLOADED FILE.
 *
 * The same trap as the media suggestion above, from the other direction: the
 * server answers 200 with a good report, and a mirror that is too STRICT rejects
 * the whole thing at the runtime parse. The wizard then shows an error state for
 * a source that reads perfectly, and nothing anywhere says why.
 */
describe("CatalogProfileReportSchema — a report about an uploaded file", () => {
  const fileReport = profileResponse({
    // Both are `""` for a file source: there is no spreadsheet to name.
    spreadsheetId: "",
    sheetName: "",
    textSource: {
      kind: "file",
      storageKey: "catalog/t1/abc",
      fileName: "bang-gia-2026.csv",
      uploadedAt: "2026-08-24T07:32:07.000Z",
    },
  });

  it("accepts a report whose spreadsheet id and tab name are empty", () => {
    expect(CatalogProfileResponseSchema.safeParse(fileReport).success).toBe(true);
  });

  it("keeps `textSource`, so a file report cannot be read as a sheet one", () => {
    const result = CatalogProfileResponseSchema.safeParse(fileReport);
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "profiled") {
      expect(result.data.report.textSource?.kind).toBe("file");
    }
  });

  it("still accepts a Google report with no textSource at all", () => {
    const result = CatalogProfileResponseSchema.safeParse(profileResponse());
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "profiled") {
      expect(result.data.report.textSource ?? null).toBeNull();
    }
  });
});
