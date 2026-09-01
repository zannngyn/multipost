import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ManualProductForm } from "../ManualProductForm";
import { EMPTY_MANUAL_PRODUCT } from "@/ui/schemas/manual-product.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * The typed-product form, asserted on real markup — the two promises this
 * screen makes to the business, plus the states an operator actually meets.
 *
 * `renderToStaticMarkup`, like `channel-group-picker-render.test.tsx`: the repo
 * runs vitest in `environment: "node"` with no jsdom, and everything that
 * matters here (a warning that is missing, a seventh input that appeared, a
 * refusal that swallowed the typed values) is visible in server-rendered HTML.
 */

function render(
  props: Partial<Parameters<typeof ManualProductForm>[0]> = {},
): string {
  return renderToStaticMarkup(
    <ManualProductForm
      productCode="MGKVX6310"
      defaultValues={EMPTY_MANUAL_PRODUCT}
      onSubmit={() => {}}
      onCancel={() => {}}
      isPending={false}
      error={null}
      readOnlyReason={null}
      {...props}
    />,
  );
}

/** Every `<input>`/`<textarea>` name attribute rendered by the form. */
function inputCount(html: string): number {
  return (html.match(/<input\b/g) ?? []).length + (html.match(/<textarea\b/g) ?? []).length;
}

describe("ManualProductForm — business rule 3 (kiểm tồn)", () => {
  it("warns that an empty stock blocks the post BEFORE anything is typed", () => {
    const html = render();
    expect(html).toContain("Nhập tay KHÔNG bỏ qua kiểm tồn kho");
    expect(html).toContain("Để trống thì bài này sẽ bị chặn đăng.");
  });

  it("keeps the warning out of the way once a stock number is there", () => {
    const html = render({
      defaultValues: { ...EMPTY_MANUAL_PRODUCT, name: "Váy hoa nhí", stockRaw: "12" },
    });
    // The standing rule stays; the per-field nag does not.
    expect(html).toContain("Nhập tay KHÔNG bỏ qua kiểm tồn kho");
    expect(html).not.toContain("Để trống thì bài này sẽ bị chặn đăng.");
  });
});

describe("ManualProductForm — business rule 2 (whitelist)", () => {
  it("offers exactly six boxes and no seventh", () => {
    // Four caption fields + tồn + lưu ý. A seventh box would be a 400 from the
    // server's strict schema AND a hole in the caption whitelist.
    expect(inputCount(render())).toBe(6);
  });

  it("has no box for a price, by any name", () => {
    const html = render();
    expect(html).not.toMatch(/giá bán|Giá\b|price/i);
  });

  it("says which fields reach a caption and which never do", () => {
    const html = render();
    expect(html).toContain("Thông tin vào caption");
    expect(html).toContain("Thông tin nội bộ");
  });
});

describe("ManualProductForm — the states", () => {
  it("data: shows the code being typed for, and the values already typed", () => {
    const html = render({
      defaultValues: { ...EMPTY_MANUAL_PRODUCT, name: "Váy hoa nhí", stockRaw: "12" },
    });
    expect(html).toContain("MGKVX6310");
    expect(html).toContain("Váy hoa nhí");
  });

  it("loading: the submit button is busy and the boxes are locked", () => {
    const html = render({ isPending: true });
    expect(html).toMatch(/aria-busy="true"|astryx-spinner/);
  });

  it("error: a refusal keeps every typed value on screen", () => {
    const html = render({
      defaultValues: { ...EMPTY_MANUAL_PRODUCT, name: "Váy hoa nhí", stockRaw: "0" },
      error: new ApiError({
        code: "OUT_OF_STOCK",
        status: 409,
        userMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      }),
    });
    expect(html).toContain("Mã MGKVX6310 đã hết hàng — không đăng");
    // The whole point: nothing typed was thrown away by the refusal.
    expect(html).toContain("Váy hoa nhí");
  });

  it("read-only (support mode): says why instead of offering a button that 403s", () => {
    const html = render({ readOnlyReason: "Phiên hỗ trợ chỉ xem, không ghi được." });
    expect(html).toContain("Phiên hỗ trợ chỉ xem, không ghi được.");
  });

  it("editing an existing typed product changes the verb, not the form", () => {
    expect(render({ isEditing: true })).toContain("Cập nhật và tra lại");
    expect(render()).toContain("Dùng thông tin này");
  });

  /**
   * The code box lives ABOVE this form and can be retyped while it is open. The
   * heading must degrade rather than print a dangling "…sản phẩm  ", and it must
   * still be six boxes and no seventh.
   */
  it("names the code it is typing for", () => {
    expect(render()).toContain(">Nhập tay thông tin sản phẩm MGKVX6310</h3>");
  });

  it("survives a momentarily empty product code without a dangling heading", () => {
    // The code box lives ABOVE this form and can be retyped while it is open.
    const html = render({ productCode: "  " });
    expect(html).toContain(">Nhập tay thông tin sản phẩm</h3>");
    expect(inputCount(html)).toBe(6);
  });
});
