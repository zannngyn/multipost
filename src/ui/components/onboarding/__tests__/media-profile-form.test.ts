import { describe, expect, it } from "vitest";

import {
  blockingMediaIssues,
  candidateFor,
  candidateSummary,
  codesInSheet,
  isMediaProfileDeclared,
  mediaIssueFor,
  mediaLinkOptions,
  mediaProfileFormFromStored,
  toMediaProfile,
  validateMediaProfileForm,
  type MediaProfileFormState,
} from "@/ui/components/onboarding/media-profile-form";
import type {
  CatalogFieldMap,
  MediaProfileCandidate,
  MediaProfileKind,
  MediaProfileSuggestion,
} from "@/ui/schemas/catalog-mapping.schema";

const EMPTY_MAP: CatalogFieldMap = {
  code: "Mã sản phẩm",
  name: "Tên sản phẩm",
  description: null,
  category: null,
  season: null,
  stock: null,
  note: null,
  colors: null,
};

function candidate(
  kind: MediaProfileKind,
  overrides: Partial<MediaProfileCandidate> = {},
): MediaProfileCandidate {
  return {
    kind,
    label: kind,
    applicable: true,
    note: null,
    assets: 100,
    rejected: 0,
    codesMatched: 50,
    score: 0.5,
    ...overrides,
  };
}

function suggestion(overrides: Partial<MediaProfileSuggestion> = {}): MediaProfileSuggestion {
  return {
    recommended: "folder-per-code",
    confidence: 0.7,
    candidates: [candidate("folder-per-code"), candidate("code-color-seq")],
    mediaLinkColumn: null,
    recursive: true,
    ...overrides,
  };
}

/**
 * The whole point of this module: "chưa khai" and "khai đúng bằng mặc định" are
 * different answers, and only the first one may be filled with a guess.
 */
describe("mediaProfileFormFromStored", () => {
  it("keeps the default when nothing is declared and no report is available", () => {
    // No Drive folder, or Drive unreadable: there is no suggestion to fall back
    // on, and the tenant is running `code-color-seq` right now.
    expect(mediaProfileFormFromStored(null, null, null)).toEqual({
      kind: "code-color-seq",
      mediaLinkColumn: null,
    });
    expect(mediaProfileFormFromStored(undefined, undefined, undefined).kind).toBe(
      "code-color-seq",
    );
  });

  it("falls back to the recommendation only while nothing is declared", () => {
    expect(mediaProfileFormFromStored(null, null, suggestion()).kind).toBe("folder-per-code");
  });

  it("restores the declared kind and never the recommendation", () => {
    const state = mediaProfileFormFromStored(
      { kind: "code-in-name" },
      null,
      suggestion({ recommended: "folder-per-code" }),
    );

    expect(state.kind).toBe("code-in-name");
  });

  it("restores a declared kind that happens to equal the default", () => {
    // The distinction that phase 1 established: a stored `code-color-seq` is an
    // answer somebody gave, not an empty slot to fill from the report.
    const state = mediaProfileFormFromStored(
      { kind: "code-color-seq" },
      null,
      suggestion({ recommended: "sheet-column", mediaLinkColumn: "Link ảnh" }),
    );

    expect(state).toEqual({ kind: "code-color-seq", mediaLinkColumn: null });
  });

  it("pre-fills the detected link column only when nothing was declared", () => {
    const detected = suggestion({ recommended: "sheet-column", mediaLinkColumn: "Link ảnh" });

    expect(mediaProfileFormFromStored(null, null, detected).mediaLinkColumn).toBe("Link ảnh");
    // Declared map, no link column in it: the operator's blank stays blank.
    expect(mediaProfileFormFromStored({ kind: "sheet-column" }, null, detected).mediaLinkColumn)
      .toBeNull();
  });

  it("prefers the stored column over the detected one", () => {
    const state = mediaProfileFormFromStored(
      null,
      "Ảnh Drive",
      suggestion({ mediaLinkColumn: "Link ảnh" }),
    );

    expect(state.mediaLinkColumn).toBe("Ảnh Drive");
  });

  it("treats a blank stored column as no column", () => {
    expect(mediaProfileFormFromStored({ kind: "sheet-column" }, "   ", null).mediaLinkColumn)
      .toBeNull();
  });
});

describe("isMediaProfileDeclared", () => {
  it("separates 'chưa khai' from a declared default", () => {
    expect(isMediaProfileDeclared(null)).toBe(false);
    expect(isMediaProfileDeclared(undefined)).toBe(false);
    expect(isMediaProfileDeclared({ kind: "code-color-seq" })).toBe(true);
  });
});

describe("toMediaProfile", () => {
  it("carries the tenant's colour vocabulary over untouched", () => {
    const stored = {
      kind: "code-color-seq" as const,
      colors: { canonical: ["XANH THAN"], includeDefaults: false },
    };

    expect(toMediaProfile({ kind: "code-in-name", mediaLinkColumn: null }, stored)).toEqual({
      kind: "code-in-name",
      colors: { canonical: ["XANH THAN"], includeDefaults: false },
    });
  });

  it("omits the key entirely when there is no vocabulary to keep", () => {
    expect(toMediaProfile({ kind: "sheet-column", mediaLinkColumn: "Link" }, null)).toEqual({
      kind: "sheet-column",
    });
  });
});

describe("validateMediaProfileForm", () => {
  const columns = ["Mã sản phẩm", "Tên sản phẩm", "Link ảnh"];

  it("refuses sheet-column without a link column", () => {
    const state: MediaProfileFormState = { kind: "sheet-column", mediaLinkColumn: null };
    const issues = validateMediaProfileForm(state, columns, EMPTY_MAP);

    expect(blockingMediaIssues(issues)).toHaveLength(1);
    expect(mediaIssueFor(issues, "mediaLinkColumn")?.message).toContain("Chọn cột chứa link");
  });

  it("says nothing about a missing link column for the other three layouts", () => {
    for (const kind of ["folder-per-code", "code-in-name", "code-color-seq"] as const) {
      expect(validateMediaProfileForm({ kind, mediaLinkColumn: null }, columns, EMPTY_MAP)).toEqual(
        [],
      );
    }
  });

  it("stays quiet when the sheet has no header row at all", () => {
    // The form already says "chưa đọc được cột nào" once; repeating it here
    // would bury the real problem.
    const state: MediaProfileFormState = { kind: "code-in-name", mediaLinkColumn: "Link ảnh" };

    expect(validateMediaProfileForm(state, [], EMPTY_MAP)).toEqual([]);
  });

  it("blocks a vanished column for sheet-column and only warns for the rest", () => {
    const gone: MediaProfileFormState = { kind: "sheet-column", mediaLinkColumn: "Ảnh cũ" };
    expect(blockingMediaIssues(validateMediaProfileForm(gone, columns, EMPTY_MAP))).toHaveLength(1);

    const kept: MediaProfileFormState = { kind: "code-in-name", mediaLinkColumn: "Ảnh cũ" };
    const issues = validateMediaProfileForm(kept, columns, EMPTY_MAP);
    expect(blockingMediaIssues(issues)).toHaveLength(0);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("warns — never blocks — when the link column also feeds a caption", () => {
    // Business rule 2, photo edition: the server does not call this a duplicate,
    // so this screen is the only place it can be said.
    const state: MediaProfileFormState = { kind: "sheet-column", mediaLinkColumn: "Link ảnh" };
    const map: CatalogFieldMap = { ...EMPTY_MAP, description: "Link ảnh" };

    const issues = validateMediaProfileForm(state, columns, map);

    expect(blockingMediaIssues(issues)).toHaveLength(0);
    expect(issues[0]?.message).toContain("đi thẳng vào caption");
  });
});

describe("candidateSummary", () => {
  const total = 299;

  it("keeps 'chưa chấm được' apart from 'ghép được 0 mã'", () => {
    expect(candidateSummary(null, total)).toContain("Chưa chấm được");

    const blind = candidate("folder-per-code", {
      applicable: false,
      note: "Chưa quét được thư mục con nên chưa chấm điểm được cách này.",
      codesMatched: 0,
    });
    expect(candidateSummary(blind, total)).toBe(
      "Chưa quét được thư mục con nên chưa chấm điểm được cách này.",
    );

    const zero = candidate("code-in-name", { codesMatched: 0, assets: 0 });
    expect(candidateSummary(zero, total)).toContain("0/299 mã có ảnh");
  });

  it("shows the evidence, not the score", () => {
    const summary = candidateSummary(candidate("code-color-seq", { codesMatched: 187 }), total);

    expect(summary).toContain("187/299 mã có ảnh");
    expect(summary).not.toContain("0.5");
  });

  it("does not divide by a sheet with no codes", () => {
    expect(candidateSummary(candidate("code-in-name"), 0)).toContain("chưa có mã nào để đối chiếu");
  });
});

describe("candidateFor", () => {
  it("returns null instead of guessing when the report has no suggestion", () => {
    expect(candidateFor(null, "sheet-column")).toBeNull();
    expect(candidateFor(suggestion(), "sheet-column")).toBeNull();
    expect(candidateFor(suggestion(), "code-color-seq")?.kind).toBe("code-color-seq");
  });
});

describe("codesInSheet", () => {
  it("reads the cross-check total, falling back to the parsed rows", () => {
    const base = {
      sheet: { productsParsed: 299 },
    } as unknown as Parameters<typeof codesInSheet>[0];

    expect(codesInSheet(base)).toBe(299);
    expect(
      codesInSheet({
        ...base,
        crossCheck: { codesInSheet: 280 },
      } as unknown as Parameters<typeof codesInSheet>[0]),
    ).toBe(280);
  });
});

describe("mediaLinkOptions", () => {
  it("offers 'no column' first and keeps a vanished column selectable", () => {
    const options = mediaLinkOptions(["A", "B"], "Cũ");

    expect(options[0]?.value).toBe("");
    expect(options.map((option) => option.value)).toEqual(["", "A", "B", "Cũ"]);
    expect(options[3]?.label).toContain("không còn trên bảng tính");
  });

  it("does not repeat a column that still exists", () => {
    expect(mediaLinkOptions(["A", "B"], "B").map((option) => option.value)).toEqual(["", "A", "B"]);
  });
});
