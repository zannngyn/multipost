import type { DetectCodeVerdict } from "@/ui/schemas/compose.schema";

/**
 * E9 — turns a detection verdict into what the screen draws: one headline
 * sentence and a list of buttons.
 *
 * Split out of JSX because this is where the rule lives: spec §8.2 says the
 * operator must NEVER retype a code the system just read from the file name,
 * and the only way to guarantee that is for the code to travel WITH the
 * button (`action.code`). Kept here it is testable without a DOM — the repo
 * has no testing-library, and none is needed for this.
 */

export type DetectedCodeActionKind = "use-code" | "sync" | "pick-code";

export interface DetectedCodeAction {
  readonly kind: DetectedCodeActionKind;
  readonly label: string;
  /** Code carried by the button. "" = open an empty manual entry. */
  readonly code: string;
  readonly variant: "primary" | "outline";
}

export interface DetectedCodeView {
  readonly title: string;
  readonly actions: readonly DetectedCodeAction[];
}

const SYNC_ACTION: DetectedCodeAction = {
  kind: "sync",
  label: "Đồng bộ lại dữ liệu",
  code: "",
  variant: "outline",
};

export function describeDetection(verdict: DetectCodeVerdict): DetectedCodeView {
  switch (verdict.status) {
    case "matched":
      return {
        title: `Đã nhận diện mã: ${verdict.productCode}`,
        actions: [
          { kind: "use-code", label: "Dùng mã này", code: verdict.productCode, variant: "primary" },
        ],
      };

    case "not_found":
      return {
        title: `Không tìm thấy sản phẩm ${verdict.productCode} trong dữ liệu đã đồng bộ.`,
        actions: [
          SYNC_ACTION,
          {
            kind: "use-code",
            label: `Nhập mã ${verdict.productCode}`,
            code: verdict.productCode,
            variant: "primary",
          },
        ],
      };

    case "conflict":
      return {
        title: `Các file đang mang ${verdict.codes.length} mã khác nhau. Chọn mã cho bài này, hoặc tách ra tải lên từng mã.`,
        actions: verdict.codes.map((code) => ({
          kind: "pick-code" as const,
          label: code,
          code,
          variant: "outline" as const,
        })),
      };

    case "no_code":
    default:
      return {
        title: "Không nhận diện được mã sản phẩm từ tên file.",
        actions: [
          SYNC_ACTION,
          { kind: "use-code", label: "Nhập mã sản phẩm", code: "", variant: "primary" },
        ],
      };
  }
}
