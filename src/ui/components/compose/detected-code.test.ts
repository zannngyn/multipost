import { describe, expect, it } from "vitest";

import { describeDetection } from "./detected-code";
import type { DetectCodeVerdict } from "@/ui/schemas/compose.schema";

describe("describeDetection", () => {
  it("names the matched code and offers to use it", () => {
    const view = describeDetection({ status: "matched", productCode: "BG0SQ6083" });
    expect(view.title).toContain("BG0SQ6083");
    expect(view.actions).toEqual([
      { kind: "use-code", label: "Dùng mã này", code: "BG0SQ6083", variant: "primary" },
    ]);
  });

  it("carries the detected code ON the manual button, so nobody retypes it (spec 8.2)", () => {
    const view = describeDetection({ status: "not_found", productCode: "BG0SQ9999" });
    const manual = view.actions.find((action) => action.kind === "use-code");
    expect(manual).toMatchObject({ label: "Nhập mã BG0SQ9999", code: "BG0SQ9999" });
  });

  it("offers a sync action when the product is not in the catalog", () => {
    const view = describeDetection({ status: "not_found", productCode: "BG0SQ9999" });
    expect(view.actions.some((action) => action.kind === "sync")).toBe(true);
    expect(view.title).toContain("BG0SQ9999");
  });

  it("offers one button per code on a conflict and picks none itself", () => {
    const view = describeDetection({ status: "conflict", codes: ["BG0SQ6083", "BG0SQ6084"] });
    const picks = view.actions.filter((action) => action.kind === "pick-code");
    expect(picks.map((action) => action.code)).toEqual(["BG0SQ6083", "BG0SQ6084"]);
    expect(view.actions.some((action) => action.kind === "use-code")).toBe(false);
  });

  it("offers sync and a BLANK manual entry when no code was found", () => {
    const view = describeDetection({ status: "no_code" });
    expect(view.title).toMatch(/không nhận diện được mã/i);
    expect(view.actions).toEqual([
      { kind: "sync", label: "Đồng bộ lại dữ liệu", code: "", variant: "outline" },
      { kind: "use-code", label: "Nhập mã sản phẩm", code: "", variant: "primary" },
    ]);
  });

  it("never returns an empty action list — a notice with no way out is a dead end", () => {
    const verdicts: readonly DetectCodeVerdict[] = [
      { status: "matched", productCode: "A" },
      { status: "not_found", productCode: "A" },
      { status: "conflict", codes: ["A", "B"] },
      { status: "no_code" },
    ];
    for (const verdict of verdicts) {
      expect(describeDetection(verdict).actions.length).toBeGreaterThan(0);
    }
  });
});
