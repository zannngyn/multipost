import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DetectedCodeNotice } from "../DetectedCodeNotice";

const noop = () => {};

describe("DetectedCodeNotice", () => {
  it("draws nothing before a verdict exists", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice verdict={null} warnings={[]} onAction={noop} isPending={false} />,
    );
    expect(html).toBe("");
  });

  it("prints the detected code inside the manual button", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "not_found", productCode: "BG0SQ9999" }}
        warnings={[]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain("Nhập mã BG0SQ9999");
    expect(html).toContain("Đồng bộ lại dữ liệu");
  });

  it("draws one button per code on a conflict", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "conflict", codes: ["BG0SQ6083", "BG0SQ6084"] }}
        warnings={[]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain("BG0SQ6083");
    expect(html).toContain("BG0SQ6084");
  });

  it("shows every warning — nothing is dropped silently (business rule 5)", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "no_code" }}
        warnings={["Chưa đọc được danh sách mã của đơn vị."]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain("Chưa đọc được danh sách mã của đơn vị.");
  });

  it("announces itself politely — the verdict arrives after a request", () => {
    const html = renderToStaticMarkup(
      <DetectedCodeNotice
        verdict={{ status: "matched", productCode: "BG0SQ6083" }}
        warnings={[]}
        onAction={noop}
        isPending={false}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
