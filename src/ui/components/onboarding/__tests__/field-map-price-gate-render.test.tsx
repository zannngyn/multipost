import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FieldMapForm } from "../FieldMapForm";
import type { CatalogFieldMap, CatalogProfileReport } from "@/ui/schemas/catalog-mapping.schema";

/**
 * F6 — the price speed bump, asserted on real markup.
 *
 * `field-map-form.test.ts` owns the RULE (which assignments count, and when a
 * confirmation stops being valid). This owns the fact that the rule reaches the
 * screen: business rule 2 is hard, a price in a public caption cannot be taken
 * back, and a yellow line an operator can save straight past is not a gate.
 *
 * What is proved here is a NEGATIVE — that "Lưu ánh xạ" cannot be pressed —
 * which is exactly the kind of thing that quietly stops being true.
 */

const COLUMNS = ["Mã sản phẩm", "Tên sản phẩm", "Mô tả", "Giá bán", "Tồn"];

function fieldMap(overrides: Partial<CatalogFieldMap> = {}): CatalogFieldMap {
  return {
    code: "Mã sản phẩm",
    name: "Tên sản phẩm",
    description: null,
    category: null,
    season: null,
    stock: "Tồn",
    note: null,
    colors: null,
    mediaLink: null,
    ...overrides,
  };
}

function report(map: CatalogFieldMap): CatalogProfileReport {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    spreadsheetId: "sheet-1",
    sheetName: "Mẫu 2026",
    textSource: null,
    driveFolderId: "folder-1",
    stockPolicyMode: "numeric",
    sheet: {
      columns: COLUMNS,
      duplicateColumns: [],
      totalRows: 10,
      emptyRows: 0,
      productsParsed: 10,
      rowsRejected: 0,
      rejectionGroups: [],
      duplicateCodes: 0,
      conflictingCodes: [],
    },
    fieldMap: {
      fieldMap: map,
      source: "tenant",
      fields: [],
      unmappedColumns: [],
      priceLikeColumns: ["Giá bán"],
      issues: [],
    },
    media: null,
    mediaProfileSuggestion: null,
    crossCheck: null,
    topIssues: [],
    warnings: [],
  };
}

/**
 * The form owns a `useProfilePreview()` mutation ("xem lại số với ánh xạ này"),
 * so it needs a real client. Retries off and no network is ever touched — the
 * mutation is only mounted, never fired, by a static render.
 */
function render(map: CatalogFieldMap): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FieldMapForm
        report={report(map)}
        storedFieldMap={map}
        storedStockPolicy={{ mode: "numeric" }}
        storedMediaProfile={null}
        isSaving={false}
        saveError={null}
        readOnlyReason={null}
        onDirtyChange={() => {}}
        onSave={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** The save button's markup, so `disabled` can be read off it. */
function saveButton(html: string): string {
  const match = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Lưu ánh xạ[\s\S]*?<\/button>/);
  return match?.[0] ?? "";
}

const CONFIRM_LABEL = "Tôi xác nhận các cột này KHÔNG chứa giá bán / giá buôn bí mật";

describe("FieldMapForm — a money-looking column mapped onto a caption field", () => {
  it("cannot be saved until it is confirmed", () => {
    expect(saveButton(render(fieldMap({ description: "Giá bán" })))).toMatch(/disabled/);
  });

  it("offers a confirmation naming the column and the field it feeds", () => {
    const html = render(fieldMap({ description: "Giá bán" }));

    expect(html).toContain(CONFIRM_LABEL);
    // The sentence has to be about THEIR data, not a rule in the abstract.
    expect(html).toContain("Giá bán");
    expect(html).toContain("Mô tả");
  });

  it("says out loud why the button will not move", () => {
    expect(render(fieldMap({ description: "Giá bán" }))).toContain(
      "Chưa lưu được: cần tích xác nhận cột trông như cột giá ở phía trên.",
    );
  });

  /**
   * The gate is a speed bump, not a wall: the match is a guess about a header,
   * so the operator can still run the read-only preview to see what the column
   * actually contains before deciding.
   */
  it("leaves the read-only preview available", () => {
    const html = render(fieldMap({ description: "Giá bán" }));
    const preview = html.match(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Chạy thử kiểm tra số liệu[\s\S]*?<\/button>/,
    )?.[0];

    expect(preview).toBeDefined();
    expect(preview).not.toMatch(/disabled/);
  });
});

describe("FieldMapForm — an ordinary map", () => {
  it("saves without any gate at all", () => {
    const html = render(fieldMap({ description: "Mô tả" }));

    expect(saveButton(html)).not.toMatch(/disabled/);
    expect(html).not.toContain(CONFIRM_LABEL);
  });

  it("does not raise the gate for money on a field that never reaches a caption", () => {
    // `stock` is internal: rule 2 is not at risk, so nothing should be asked.
    const html = render(fieldMap({ stock: "Giá bán" }));

    expect(saveButton(html)).not.toMatch(/disabled/);
    expect(html).not.toContain(CONFIRM_LABEL);
  });
});
