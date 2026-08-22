import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BulkProgressTable } from "./BulkProgressTable";
import type { BulkRunRow } from "@/ui/hooks/useBulkRun";
import { BULK_ROW_STATUSES, BULK_ROW_STATUS_LABELS } from "@/ui/schemas/bulk.schema";

/**
 * The per-code result table, asserted on real markup.
 *
 * `renderToStaticMarkup`, like `channel-group-picker-render.test.tsx`: the repo
 * runs vitest in `environment: "node"` with no jsdom, and everything at stake
 * here (a status shown as colour only, a wrapped product code, a scroll region
 * no keyboard can reach) is visible in the server-rendered HTML.
 */

function row(overrides: Partial<BulkRunRow> = {}): BulkRunRow {
  return {
    code: "MGKVX6310",
    status: "pending",
    productName: null,
    reason: null,
    errorCode: null,
    batchId: null,
    channelCount: 2,
    ...overrides,
  };
}

function render(rows: readonly BulkRunRow[]): string {
  return renderToStaticMarkup(<BulkProgressTable rows={rows} />);
}

describe("BulkProgressTable", () => {
  it("names every status in words, not colour alone (The Named Status Rule)", () => {
    const html = render(BULK_ROW_STATUSES.map((status) => row({ status })));

    for (const status of BULK_ROW_STATUSES) {
      expect(html).toContain(BULK_ROW_STATUS_LABELS[status]);
    }
  });

  it("keeps the product code on one line in the ledger mono", () => {
    const html = render([row({ code: "MGKVX6310" })]);
    const cell = html.match(/<td[^>]*>MGKVX6310<\/td>/)?.[0];

    expect(cell).toBeDefined();
    expect(cell).toContain("font-mono");
    expect(cell).toContain("whitespace-nowrap");
    // The old `break-all` split a code across two lines, which is a different
    // string to the eye reading it back to the Sheet.
    expect(cell).not.toContain("break-all");
  });

  it("gives the sideways scroll a name and a tab stop", () => {
    const html = render([row()]);

    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("cuộn ngang được");
  });

  it("shows the refusal sentence and its error code on the row that was refused", () => {
    const html = render([
      row({
        status: "skipped",
        reason: "Mã MGKVX6310 đã hết hàng — không đăng.",
        errorCode: "OUT_OF_STOCK",
      }),
    ]);

    expect(html).toContain("đã hết hàng");
    expect(html).toContain("OUT_OF_STOCK");
    expect(html).toContain(BULK_ROW_STATUS_LABELS.skipped);
  });

  it("links a created batch and says how many channels it holds", () => {
    const html = render([row({ status: "done", batchId: "batch 1/2", channelCount: 3 })]);

    expect(html).toContain('href="/batches/batch%201%2F2"');
    expect(html).toContain("Xem lô (3 kênh)");
  });

  it("renders the header row even with no rows yet", () => {
    const html = render([]);

    expect(html).toContain("Mã sản phẩm");
    expect(html).toContain("Lý do / ghi chú");
  });
});
