import { describe, expect, it } from "vitest";

import {
  decodeCsvText,
  detectCsvDelimiter,
  looksBinary,
  looksLikeZipArchive,
  parseCsv,
} from "../csv";

/** Edge cases first (CLAUDE.md technical rule 1) — the happy path is last. */

const encoder = new TextEncoder();

function withBom(text: string, bom: readonly number[]): Uint8Array {
  const body = encoder.encode(text);
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

describe("decodeCsvText", () => {
  it("returns empty text for empty bytes instead of throwing", () => {
    const result = decodeCsvText(new Uint8Array());
    expect(result).toMatchObject({ text: "", encoding: "utf-8", hadBom: false });
  });

  it("strips the UTF-8 BOM Excel writes, so the first header is not '\\uFEFFMã'", () => {
    const result = decodeCsvText(withBom("Mã sản phẩm,Tên\nA,B\n", [0xef, 0xbb, 0xbf]));
    expect(result.hadBom).toBe(true);
    expect(result.text.startsWith("Mã sản phẩm")).toBe(true);
    expect(result.replacementCount).toBe(0);
  });

  it("decodes UTF-16 LE and BE (Excel 'Unicode Text' export)", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x2c, 0x00, 0x42, 0x00]);
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x2c, 0x00, 0x42]);
    expect(decodeCsvText(le)).toMatchObject({ text: "A,B", encoding: "utf-16le", hadBom: true });
    expect(decodeCsvText(be)).toMatchObject({ text: "A,B", encoding: "utf-16be", hadBom: true });
  });

  it("counts replacement characters when the file is not UTF-8 (never silently mojibake)", () => {
    // "Tồn" in Windows-1258/CP1252 bytes — invalid UTF-8 sequences.
    const bytes = new Uint8Array([0x54, 0xe1, 0xbb, 0x93, 0x6e, 0xff, 0xfd, 0x2c, 0x41]);
    expect(decodeCsvText(bytes).replacementCount).toBeGreaterThan(0);
  });
});

describe("looksBinary", () => {
  it("flags an .xlsx renamed to .csv (zip signature)", () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(looksBinary(xlsx)).toBe(true);
    expect(looksLikeZipArchive(xlsx)).toBe(true);
  });

  it("flags a legacy .xls (OLE signature)", () => {
    expect(looksBinary(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toBe(true);
  });

  it("does not flag UTF-16 text, whose NUL bytes are legitimate", () => {
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
  });

  it("does not flag plain UTF-8 text", () => {
    expect(looksBinary(encoder.encode("Mã,Tên\nA,B\n"))).toBe(false);
  });
});

describe("detectCsvDelimiter", () => {
  it("reads a Vietnamese Excel export as semicolon separated", () => {
    const text = "Mã sản phẩm;Tên sản phẩm;Tồn\nMGKVX6310;Váy Giannal;104\n";
    expect(detectCsvDelimiter(text).delimiter).toBe(";");
  });

  it("keeps the comma when a quoted cell contains semicolons", () => {
    const text = 'Mã,Mô tả\nA,"xanh; đỏ; vàng"\nB,"be; kem"\n';
    expect(detectCsvDelimiter(text).delimiter).toBe(",");
  });

  it("detects tabs", () => {
    expect(detectCsvDelimiter("Mã\tTên\nA\tB\n").delimiter).toBe("\t");
  });

  it("falls back to comma and says it detected nothing for a one-column file", () => {
    expect(detectCsvDelimiter("Mã\nA\nB\n")).toMatchObject({ delimiter: ",", detected: false });
  });

  it("prefers the consistent delimiter over the wider but ragged one", () => {
    // Commas appear inside the free-text column of a semicolon file.
    const text = "Mã;Mô tả\nA;váy dài, tay lỡ, cổ tròn\nB;áo\n";
    expect(detectCsvDelimiter(text).delimiter).toBe(";");
  });
});

describe("parseCsv — malformed input", () => {
  it("returns an empty grid for an empty string", () => {
    expect(parseCsv("")).toMatchObject({ rows: [], issues: [] });
  });

  it("reports an unterminated quote instead of swallowing the rest of the file", () => {
    const result = parseCsv('Mã,Tên\nA,"Váy dài\nB,Áo\n');
    expect(result.issues.map((issue) => issue.code)).toContain("UNTERMINATED_QUOTE");
    expect(result.issues[0]?.recordNumber).toBe(2);
  });

  it("reports rows narrower/wider than the header with their row number", () => {
    const result = parseCsv("Mã,Tên,Tồn\nA,Váy\nB,Áo,3,thừa\n");
    const ragged = result.issues.filter((issue) => issue.code === "RAGGED_ROW");
    expect(ragged.map((issue) => issue.recordNumber)).toEqual([2, 3]);
  });

  it("keeps a stray quote as a literal and says so", () => {
    const result = parseCsv('Mã,Tên\nA,Váy 20" dài\n');
    expect(result.rows[1]).toEqual(["A", 'Váy 20" dài']);
    expect(result.issues.map((issue) => issue.code)).toContain("STRAY_QUOTE");
  });

  it("does not invent a last row from a trailing newline", () => {
    expect(parseCsv("Mã,Tên\nA,B\n").rows).toHaveLength(2);
  });

  it("keeps the last row when the file has no trailing newline", () => {
    expect(parseCsv("Mã,Tên\nA,B").rows).toEqual([
      ["Mã", "Tên"],
      ["A", "B"],
    ]);
  });

  it("drops trailing all-empty rows and counts them", () => {
    const result = parseCsv("Mã,Tên\nA,B\n,\n,\n");
    expect(result.rows).toHaveLength(2);
    expect(result.trailingEmptyRows).toBe(2);
  });

  it("keeps a blank row in the middle so its row number stays honest", () => {
    const result = parseCsv("Mã,Tên\n,\nB,C\n");
    expect(result.rows).toHaveLength(3);
    expect(result.rows[1]).toEqual(["", ""]);
  });
});

describe("parseCsv — Excel's own additions", () => {
  it("obeys the `sep=;` directive line and does not treat it as a header", () => {
    const result = parseCsv("sep=;\nMã;Tên\nA;B\n");
    expect(result).toMatchObject({ delimiter: ";", separatorDirective: ";", firstRowNumber: 2 });
    expect(result.rows[0]).toEqual(["Mã", "Tên"]);
  });

  it("ignores a `sep=` line declaring something that is not a known separator", () => {
    const result = parseCsv("sep=x\nMã,Tên\nA,B\n");
    expect(result.separatorDirective).toBeNull();
    expect(result.rows[0]).toEqual(["sep=x"]);
  });

  it("lets the caller's delimiter win over the directive", () => {
    const result = parseCsv("sep=;\nMã;Tên\nA;B\n", { delimiter: "," });
    expect(result).toMatchObject({ delimiter: ",", delimiterDetected: false });
  });

  it("skips blank rows above the header and keeps the original line numbers", () => {
    const result = parseCsv("\n\nMã,Tên\nA,B\n");
    expect(result).toMatchObject({ leadingEmptyRows: 2, firstRowNumber: 3 });
    expect(result.rows[0]).toEqual(["Mã", "Tên"]);
  });

  it("numbers a ragged row by its line in the FILE, not in the trimmed table", () => {
    const result = parseCsv("sep=,\n\nMã,Tên,Tồn\nA,Váy\n");
    const ragged = result.issues.find((issue) => issue.code === "RAGGED_ROW");
    expect(ragged?.recordNumber).toBe(4);
  });
});

describe("parseCsv — quoting rules", () => {
  it("keeps a delimiter that sits inside quotes", () => {
    expect(parseCsv('Mã,Mô tả\nA,"váy dài, tay lỡ"\n').rows[1]).toEqual(["A", "váy dài, tay lỡ"]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('Mã,Tên\nA,"Váy ""Giannal"" mới"\n').rows[1]).toEqual([
      "A",
      'Váy "Giannal" mới',
    ]);
  });

  it("keeps a newline inside a quoted cell inside that one cell", () => {
    const result = parseCsv('Mã,Mô tả\nA,"dòng 1\ndòng 2"\nB,x\n');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[1]?.[1]).toBe("dòng 1\ndòng 2");
    expect(result.rows[2]).toEqual(["B", "x"]);
  });

  it("handles CRLF and a lone CR as record separators", () => {
    expect(parseCsv("Mã,Tên\r\nA,B\r\n").rows).toHaveLength(2);
    expect(parseCsv("Mã,Tên\rA,B\r").rows).toHaveLength(2);
  });

  it("keeps CRLF inside a quoted cell", () => {
    expect(parseCsv('Mã,Mô tả\r\nA,"d1\r\nd2"\r\n').rows[1]?.[1]).toBe("d1\r\nd2");
  });

  it("keeps empty cells as empty strings, not as missing fields", () => {
    expect(parseCsv("Mã,Tên,Tồn\nA,,3\n").rows[1]).toEqual(["A", "", "3"]);
    expect(parseCsv('Mã,Tên,Tồn\nA,"",3\n').rows[1]).toEqual(["A", "", "3"]);
  });

  it("honours a caller-forced delimiter and reports it was not detected", () => {
    const result = parseCsv("Mã;Tên\nA;B\n", { delimiter: ";" });
    expect(result).toMatchObject({ delimiter: ";", delimiterDetected: false });
    expect(result.rows[1]).toEqual(["A", "B"]);
  });

  it("ignores an unknown forced delimiter and detects instead", () => {
    const result = parseCsv("Mã;Tên\nA;B\n", { delimiter: "@@" });
    expect(result).toMatchObject({ delimiter: ";", delimiterDetected: true });
  });
});

describe("parseCsv — the real MYSP export", () => {
  it("reads the sample sheet with the same shape the Sheets adapter produces", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("sample-data/sheet-mau2026-snapshot-2026-08-12.csv");
    const decoded = decodeCsvText(new Uint8Array(raw));
    const result = parseCsv(decoded.text);

    expect(result.delimiter).toBe(",");
    expect(result.rows[0]).toContain("Mã sản phẩm");
    expect(result.rows.length).toBeGreaterThan(290);
    expect(result.issues.filter((issue) => issue.code === "UNTERMINATED_QUOTE")).toHaveLength(0);
  });
});
