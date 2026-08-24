import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogFileRef, CatalogSourceRef } from "@/core/ports/catalog-text-source";
import type { Logger } from "@/core/ports/infra";

import { makeCsvCatalogTextSource } from "./csv-text-source";

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000c5");
const encoder = new TextEncoder();

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

function build(maxBytes?: number) {
  return makeCsvCatalogTextSource({
    logger: makeLogger(),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
}

function fileRef(text: string | Uint8Array, overrides: Partial<CatalogFileRef> = {}): CatalogFileRef {
  return {
    kind: "file",
    fileName: "bang-gia.csv",
    contentType: "text/csv",
    bytes: typeof text === "string" ? encoder.encode(text) : text,
    ...overrides,
  };
}

async function readError(ref: unknown): Promise<AppError> {
  try {
    await build().readCatalog({ tenantId: TENANT, ref: ref as CatalogSourceRef });
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the read to be refused");
}

/** Edge cases first (CLAUDE.md technical rule 1). */

describe("canRead", () => {
  it("claims every uploaded file and no spreadsheet ref", () => {
    const source = build();
    expect(source.canRead(fileRef("a,b\n1,2\n"))).toBe(true);
    expect(source.canRead(fileRef("x", { fileName: "gia.xlsx" }))).toBe(true);
    expect(
      source.canRead({ kind: "google_sheet", spreadsheetId: "1abc", sheetName: "Mẫu 2026" }),
    ).toBe(false);
  });

  it("does not throw on a malformed ref", () => {
    expect(() => build().canRead(undefined as unknown as CatalogSourceRef)).not.toThrow();
  });
});

describe("readCatalog — refusals", () => {
  it("rejects a ref that is not a file", async () => {
    const error = await readError({ kind: "file", fileName: "", contentType: null, bytes: null });
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.context.reason).toBe("CATALOG_FILE_REF_INVALID");
  });

  it("rejects an empty file instead of importing zero products", async () => {
    const error = await readError(fileRef(""));
    expect(error.context.reason).toBe("CATALOG_FILE_EMPTY");
    expect(error.userMessage).toContain("rỗng");
  });

  it("rejects a file over the size cap", async () => {
    const big = "Mã,Tên\n" + "A,B\n".repeat(500);
    let caught: AppError | null = null;
    try {
      await build(64).readCatalog({ tenantId: TENANT, ref: fileRef(big) });
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught?.context.reason).toBe("CATALOG_FILE_TOO_LARGE");
  });

  it("tells the operator how to export CSV when an .xlsx is uploaded", async () => {
    const error = await readError(fileRef("anything", { fileName: "Bảng giá.xlsx" }));
    expect(error.context.reason).toBe("CATALOG_FILE_IS_WORKBOOK");
    expect(error.userMessage).toContain("CSV UTF-8");
  });

  it("catches an .xlsx renamed to .csv by its bytes, not its name", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    const error = await readError(fileRef(zip));
    expect(error.context.reason).toBe("CATALOG_FILE_IS_WORKBOOK");
    expect(error.userMessage).toContain("đổi tên đuôi file là không đủ");
  });

  it("rejects a file whose extension is not a text table", async () => {
    const error = await readError(
      fileRef("Mã,Tên\nA,B\n", { fileName: "danh-muc.pdf", contentType: "application/pdf" }),
    );
    expect(error.context.reason).toBe("CATALOG_FILE_EXTENSION_UNSUPPORTED");
  });

  it("refuses a non-UTF-8 export instead of importing mojibake", async () => {
    // "Tồn" written by Excel in CP1258 — invalid UTF-8 byte sequences.
    const bytes = new Uint8Array([
      0x4d, 0xe3, 0x2c, 0x54, 0xea, 0x6e, 0x0a, 0x41, 0x2c, 0x56, 0xa1, 0x79, 0x0a,
    ]);
    const error = await readError(fileRef(bytes));
    expect(error.context.reason).toBe("CATALOG_FILE_ENCODING");
    expect(error.userMessage).toContain("UTF-8");
    expect(error.context.replacement_chars).toBeGreaterThan(0);
  });

  it("rejects a file with no readable record", async () => {
    const error = await readError(fileRef("\n\n\n"));
    expect(error.context.reason).toBe("CATALOG_FILE_NO_ROWS");
  });
});

describe("readCatalog — how the file was understood", () => {
  it("reads a Vietnamese-locale semicolon export and says so", async () => {
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef("Mã sản phẩm;Tên sản phẩm;Tồn\r\nMGKVX6310;Váy Giannal;104\r\n"),
    });

    expect(result.format).toMatchObject({ delimiter: ";", detected: true, encoding: "utf-8" });
    expect(result.snapshot.columns).toEqual(["Mã sản phẩm", "Tên sản phẩm", "Tồn"]);
    expect(result.snapshot.rows[0]).toMatchObject({
      rowNumber: 2,
      values: { "Mã sản phẩm": "MGKVX6310", "Tên sản phẩm": "Váy Giannal", Tồn: "104" },
    });
    const detected = result.notices.find((notice) => notice.code === "DELIMITER_DETECTED");
    expect(detected?.detail).toContain("chấm phẩy");
  });

  it("honours an operator-chosen delimiter and reports it was not detected", async () => {
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef("Mã;Tên\nA;B\n", { delimiter: ";" }),
    });
    expect(result.format).toMatchObject({ delimiter: ";", detected: false });
    expect(result.notices.map((notice) => notice.code)).not.toContain("DELIMITER_DETECTED");
  });

  it("strips the UTF-8 BOM so the first column keeps its name", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("Mã,Tên\nA,B\n")]);
    const result = await build().readCatalog({ tenantId: TENANT, ref: fileRef(bytes) });
    expect(result.snapshot.columns).toEqual(["Mã", "Tên"]);
  });

  it("obeys Excel's sep= line, drops it, and keeps row numbers honest", async () => {
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef("sep=;\nMã;Tên\nA;Váy\n"),
    });

    expect(result.format.delimiter).toBe(";");
    expect(result.snapshot.columns).toEqual(["Mã", "Tên"]);
    // The header sits on line 2 of the file, so the first data row is line 3.
    expect(result.snapshot.rows[0]?.rowNumber).toBe(3);
    expect(result.notices.map((notice) => notice.code)).toContain("SEPARATOR_DIRECTIVE");
  });

  it("skips blank rows above the header and still points at the real line", async () => {
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef("\n\nMã,Tên\nA,Váy\n"),
    });
    expect(result.snapshot.columns).toEqual(["Mã", "Tên"]);
    expect(result.snapshot.rows[0]?.rowNumber).toBe(4);
    expect(result.notices.find((notice) => notice.code === "LEADING_EMPTY_ROWS")?.count).toBe(2);
  });

  it("keeps a quoted comma, an escaped quote and a newline inside one cell", async () => {
    const csv = 'Mã,Mô tả\nA,"váy dài, tay lỡ"\nB,"tên ""đẹp"""\nC,"dòng 1\ndòng 2"\n';
    const result = await build().readCatalog({ tenantId: TENANT, ref: fileRef(csv) });

    expect(result.snapshot.rows.map((row) => row.values["Mô tả"])).toEqual([
      "váy dài, tay lỡ",
      'tên "đẹp"',
      "dòng 1\ndòng 2",
    ]);
  });

  it("reports ragged rows and duplicate headers instead of hiding them", async () => {
    const csv = "Mã,Tên,Tồn,Tên\nA,Váy\nB,Áo,3,x\n";
    const result = await build().readCatalog({ tenantId: TENANT, ref: fileRef(csv) });

    const codes = result.notices.map((notice) => notice.code);
    expect(codes).toContain("RAGGED_ROW");
    expect(codes).toContain("DUPLICATE_COLUMN");
    expect(result.snapshot.columns).toEqual(["Mã", "Tên", "Tồn"]);
    // A missing cell is an empty value, never a shifted column.
    expect(result.snapshot.rows[0]?.values).toEqual({ Mã: "A", Tên: "Váy", Tồn: "" });
  });

  it("reports the unterminated quote of a half-edited file", async () => {
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef('Mã,Tên\nA,"Váy dài\nB,Áo\n'),
    });
    const notice = result.notices.find((n) => n.code === "UNTERMINATED_QUOTE");
    expect(notice?.detail).toContain("dòng 2");
  });

  it("keeps the last row when the file has no trailing newline, and drops blank tail rows", async () => {
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef("Mã,Tên\nA,Váy\n,\n,\nB,Áo"),
    });
    expect(result.snapshot.rows.map((row) => row.values["Mã"])).toEqual(["A", "", "", "B"]);

    const trailing = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef("Mã,Tên\nA,Váy\n,\n,\n"),
    });
    expect(trailing.snapshot.rows).toHaveLength(1);
    expect(trailing.notices.find((notice) => notice.code === "TRAILING_EMPTY_ROWS")?.count).toBe(2);
  });
});

describe("readCatalog — the real MYSP export", () => {
  it("produces the same columns the Sheets adapter produces from the same table", async () => {
    const bytes = new Uint8Array(readFileSync("sample-data/sheet-mau2026-snapshot-2026-08-12.csv"));
    const result = await build().readCatalog({
      tenantId: TENANT,
      ref: fileRef(bytes, { fileName: "sheet-mau2026.csv" }),
    });

    expect(result.format.delimiter).toBe(",");
    expect(result.snapshot.columns).toContain("Mã sản phẩm");
    expect(result.snapshot.columns).toContain("Tồn");
    expect(result.snapshot.rows.length).toBeGreaterThan(290);
    // Row 2 of the real export is the first product row.
    expect(result.snapshot.rows[0]?.rowNumber).toBe(2);
    expect(result.snapshot.rows[0]?.values["Mã sản phẩm"]).toMatch(/^[A-Z0-9-]+$/);
  });
});
