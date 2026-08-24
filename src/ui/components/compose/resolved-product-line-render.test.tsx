import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResolvedProductLine } from "./ResolvedProductLine";
import type { ComposeResponse } from "@/ui/schemas/compose.schema";

/**
 * The one line that answers "bài này đang dùng dữ liệu của mã nào" — and, since
 * onboarding phase 3, "dữ liệu đó ở đâu ra".
 *
 * Provenance is the requirement being locked here: a post built from a typed
 * product has to be recognisable as one, and it has to be read from the SERVER's
 * `productOrigin` rather than from anything this session happens to remember.
 */

function composed(overrides: Partial<ComposeResponse> = {}): ComposeResponse {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    productCode: "MGKVX6310",
    channel: "facebook",
    productOrigin: "sheet",
    content: {
      code: "MGKVX6310",
      name: "Váy hoa nhí",
      description: "Vải lụa mềm",
      category: "Váy",
      season: "Hè 2026",
    },
    inventory: {
      status: "in_stock",
      blocked: false,
      reason: null,
      stock: 62,
      operatorMessage: null,
      stockCheckSkipped: false,
      stockCheckSkippedReason: null,
    },
    media: [],
    availableColors: ["TRẮNG"],
    warnings: [],
    video: null,
    ...overrides,
  };
}

function render(response: ComposeResponse): string {
  return renderToStaticMarkup(
    <ResolvedProductLine
      id="code-hint"
      composed={response}
      albumCount={8}
      onChangeProduct={() => {}}
    />,
  );
}

describe("ResolvedProductLine — where the data came from", () => {
  it("marks a typed product as typed", () => {
    expect(render(composed({ productOrigin: "manual" }))).toContain("Nhập tay");
  });

  it("draws no badge for a synced product — the common case stays quiet", () => {
    expect(render(composed())).not.toContain("Nhập tay");
  });

  /**
   * The badge follows the SERVER's answer, not the session: a product typed last
   * week and reused today arrives as `manual` with nothing on any form.
   */
  it("marks a reused typed product even with an empty screen state", () => {
    const html = render(composed({ productOrigin: "manual", availableColors: [] }));
    expect(html).toContain("Nhập tay");
    expect(html).toContain("MGKVX6310");
  });
});

describe("ResolvedProductLine — internal facts stay internal but visible", () => {
  it("shows the stock on the operator tool", () => {
    expect(render(composed())).toContain("tồn 62");
  });

  it("says 'chưa có số tồn' rather than reading an empty cell as zero", () => {
    const html = render(
      composed({
        productOrigin: "manual",
        inventory: {
          status: "in_stock",
          blocked: false,
          reason: null,
          stock: null,
          operatorMessage: null,
          stockCheckSkipped: false,
          stockCheckSkippedReason: null,
        },
      }),
    );
    expect(html).toContain("chưa có số tồn");
    expect(html).not.toContain("tồn 0");
  });
});
