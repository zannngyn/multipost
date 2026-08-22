import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BulkProgressTable } from "./BulkProgressTable";
import { Badge } from "@/ui/components/ui/badge";
import type { BulkRunRow } from "@/ui/hooks/useBulkRun";
import {
  BULK_ROW_STATUSES,
  BULK_ROW_STATUS_LABELS,
  BULK_ROW_STATUS_TONES,
  type BulkRowStatus,
} from "@/ui/schemas/bulk.schema";

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

  it("dyes ALL EIGHT statuses with the tone their schema assigns them", () => {
    // What this table owes: every row wears the tone `BULK_ROW_STATUS_TONES`
    // says it wears — "Đã tạo lô" painted madder is a lie an operator acts on.
    //
    // The oracle is Badge itself, not a list of utility classes. Naming
    // `bg-success/10` here made this test fail on a purely internal Badge
    // change, and covered 4 of 8 statuses while looking like it covered the
    // dye system. `badge.test.tsx` owns which tone paints which tint; this
    // owns which tone each status gets.
    const classOf = (label: string, html: string): string | undefined =>
      html.match(new RegExp(`<span[^>]*class="([^"]*)"[^>]*>${label}</span>`))?.[1];

    const asBadge = (status: BulkRowStatus): string | undefined => {
      const label = BULK_ROW_STATUS_LABELS[status];
      return classOf(
        label,
        renderToStaticMarkup(<Badge tone={BULK_ROW_STATUS_TONES[status]}>{label}</Badge>),
      );
    };

    const html = render(BULK_ROW_STATUSES.map((status) => row({ status })));

    for (const status of BULK_ROW_STATUSES) {
      const expected = asBadge(status);
      expect(expected).toBeDefined();
      expect(classOf(BULK_ROW_STATUS_LABELS[status], html)).toBe(expected);
    }

    // …and the assertion above is only worth anything if the tones are actually
    // told apart on screen. Five distinct tones in the map must be five
    // distinct appearances, or every row could wear the same dye and still pass.
    expect(new Set(BULK_ROW_STATUSES.map(asBadge)).size).toBe(
      new Set(Object.values(BULK_ROW_STATUS_TONES)).size,
    );
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

  it("uses the app's ONE scroll-cue frame, not a sentence of its own", () => {
    // Ruling T3: `TableScrollRegion` + `scroll-cue-x` is the single pattern for
    // a table wider than its box. This table used to print its own hint under
    // itself, keyed to a container breakpoint guessed from `min-w-160` — a
    // second dialect for the same fact, and one that could not tell whether the
    // table was really overflowing.
    const html = render([row()]);

    expect(html).toContain("scroll-cue-x");
    expect(html).not.toContain("Cuộn bảng sang phải");
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
