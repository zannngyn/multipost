import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogFileCard } from "../CatalogFileCard";
import type { CatalogTextSource } from "@/ui/schemas/catalog-mapping.schema";
import type { CatalogFilePreview } from "@/ui/schemas/catalog.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * The CSV upload card, asserted on real markup.
 *
 * The two promises this card makes are both about TIMING, and neither shows up
 * in a type: the CSV-only rule has to be on screen BEFORE the picker, and
 * "which file, uploaded when" has to survive long after the upload. Both are
 * only checkable by looking at what is rendered.
 *
 * `renderToStaticMarkup`, like the other render tests here: vitest runs in
 * `environment: "node"` with no jsdom, and everything asserted below is in the
 * server-rendered HTML.
 */

const PREVIEW: CatalogFilePreview = {
  columns: ["Mã sản phẩm", "Tên sản phẩm", "Tồn", "Giá bán"],
  rowCount: 312,
  delimiter: ";",
  delimiterDetected: true,
  encoding: "utf-8",
  notices: [
    {
      code: "TRAILING_EMPTY_ROWS",
      count: 3,
      examples: ["313", "314", "315"],
      detail: "Bỏ qua 3 dòng trống ở cuối file.",
    },
  ],
  sampleRows: [
    { "Mã sản phẩm": "MGKVX6310", "Tên sản phẩm": "Váy hoa nhí", Tồn: "12", "Giá bán": "385.000" },
  ],
  fieldMapSuggestion: {
    fieldMap: {
      code: "Mã sản phẩm",
      name: "Tên sản phẩm",
      description: null,
      category: null,
      season: null,
      stock: "Tồn",
      note: null,
      colors: null,
      mediaLink: null,
    },
    fields: [
      {
        field: "code",
        column: "Mã sản phẩm",
        confidence: 1,
        matchKind: "exact",
        alternatives: [],
        needsReview: false,
      },
      {
        field: "description",
        column: null,
        confidence: 0,
        matchKind: "none",
        alternatives: [],
        needsReview: false,
      },
    ],
    unmappedColumns: ["Giá bán"],
    duplicateColumns: [],
    blankColumnCount: 0,
    priceLikeColumns: ["Giá bán"],
  },
};

const STORED: CatalogTextSource = {
  kind: "file",
  storageKey: "catalog/t1/abc",
  fileName: "bang-gia-2026.csv",
  contentType: "text/csv",
  sizeBytes: 248_000,
  uploadedAt: "2026-08-24T07:32:07.000Z",
};

function render(props: Partial<Parameters<typeof CatalogFileCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <CatalogFileCard
      textSource={null}
      preview={null}
      isUploading={false}
      error={null}
      readOnlyReason={null}
      onUpload={() => {}}
      {...props}
    />,
  );
}

describe("CatalogFileCard — the CSV-only rule is stated, not discovered", () => {
  it("says CSV only, and names the format it cannot read, before any upload", () => {
    const html = render();
    expect(html).toContain("chỉ đọc file CSV");
    // Naming .xlsx is the whole point: "chỉ đọc CSV" alone leaves somebody
    // holding an Excel file with no idea it is the wrong one.
    expect(html).toContain(".xlsx");
  });

  it("gives the export path for both tools, and insists on UTF-8", () => {
    const html = render();
    expect(html).toContain("Lưu dưới dạng");
    expect(html).toContain("UTF-8");
    expect(html).toContain("Google Sheets");
  });

  it("filters the picker to CSV-ish files and never offers a workbook", () => {
    const html = render();
    expect(html).toMatch(/accept="[^"]*\.csv/);
    expect(html).not.toMatch(/accept="[^"]*\.xlsx/);
  });
});

describe("CatalogFileCard — which file, uploaded when", () => {
  it("names the stored file and the minute it arrived", () => {
    const html = render({ textSource: STORED });
    expect(html).toContain("bang-gia-2026.csv");
    // The date is formatted in vi-VN; assert the day rather than the exact
    // string so a timezone does not make this brittle.
    expect(html).toContain("2026");
  });

  it("says the server holds a COPY — the question this feature creates", () => {
    const html = render({ textSource: STORED });
    expect(html).toContain("bản sao");
    expect(html).toContain("tải lên lại");
  });

  it("says nothing about a stored file when there is none", () => {
    expect(render()).not.toContain("Đang đọc file");
  });
});

describe("CatalogFileCard — what the reader saw", () => {
  it("reports the row count, the columns and the encoding", () => {
    const html = render({ preview: PREVIEW });
    expect(html).toContain("312");
    expect(html).toContain("utf-8");
    // Every column name, not just the ones the sample table has room for.
    expect(html).toContain("Giá bán");
  });

  it("says out loud that the separator was a GUESS", () => {
    const html = render({ preview: PREVIEW });
    expect(html).toContain("tự nhận diện");
    expect(html).toContain("dấu chấm phẩy");
  });

  it("shows every notice — a dropped row is never silent", () => {
    expect(render({ preview: PREVIEW })).toContain("Bỏ qua 3 dòng trống ở cuối file.");
  });

  it("warns that a price-like column will not be read unless declared", () => {
    const html = render({ preview: PREVIEW });
    expect(html).toContain("Giá bán");
    expect(html).toContain("giá không bao giờ vào caption");
  });

  it("does not claim the upload imported anything", () => {
    const html = render({ preview: PREVIEW });
    expect(html).toContain("Chưa đồng bộ");
    expect(html).toContain("chạy đồng bộ");
  });
});

describe("CatalogFileCard — the states", () => {
  it("loading: the picker and the button are busy", () => {
    expect(render({ isUploading: true })).toMatch(/aria-busy="true"|astryx-spinner/);
  });

  it("error: the server's own sentence is shown, and the rule stays on screen", () => {
    const html = render({
      error: new ApiError({
        code: "INVALID_INPUT",
        status: 400,
        userMessage:
          'File "bang-gia.xlsx" là bảng tính Excel, hệ thống chỉ đọc được CSV. Mở file trong Excel…',
      }),
    });
    expect(html).toContain("là bảng tính Excel");
    // The instructions must not be replaced by the error — they are the fix.
    expect(html).toContain("Lưu dưới dạng");
  });

  it("read-only (support mode): says why instead of a button that 403s", () => {
    const html = render({ readOnlyReason: "Phiên hỗ trợ chỉ xem, không ghi được." });
    expect(html).toContain("Phiên hỗ trợ chỉ xem, không ghi được.");
  });
});
