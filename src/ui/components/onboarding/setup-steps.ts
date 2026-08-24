import {
  stepFlag,
  type SetupProgress,
  type SetupStepId,
} from "@/ui/schemas/setup-progress.schema";

import type { StepState, StepView } from "./first-run.types";

/**
 * Six flags -> six rows on the screen.
 *
 * A PURE function on purpose: every rule about what is locked, what comes next
 * and what the operator is told lives here, testable without rendering
 * anything. The dock and the full checklist both call it, so the small card in
 * the corner can never disagree with the big one on the overview.
 */

export interface SetupStepPresentation {
  readonly id: SetupStepId;
  readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  readonly title: string;
  readonly description: string;
  /** Rough minutes, shown as "2 ph" — an estimate, never a promise. */
  readonly minutes: number;
  /** Screen that OWNS this step. Clicking the row goes here. */
  readonly href: string;
  /** Steps that must be done first. Empty = always open. */
  readonly requires: readonly SetupStepId[];
  /** Shown when `requires` is not satisfied. Null when nothing can lock it. */
  readonly lockedReason: string | null;
}

export const SETUP_STEP_PRESENTATION: readonly SetupStepPresentation[] = [
  {
    id: "tenant",
    ordinal: 1,
    title: "Tạo tổ chức",
    description: "Công ty sở hữu toàn bộ sản phẩm, kênh và nhật ký đăng bài.",
    minutes: 1,
    href: "/",
    requires: [],
    lockedReason: null,
  },
  {
    id: "google",
    ordinal: 2,
    title: "Kết nối Google Drive",
    description: "Cho MYSP đọc kho ảnh sản phẩm trong Drive của bạn.",
    minutes: 2,
    href: "/sync",
    requires: [],
    lockedReason: null,
  },
  {
    id: "source",
    ordinal: 3,
    title: "Nối Google Sheet sản phẩm",
    description: "Chọn thư mục ảnh và bảng tính chứa tên, mô tả, tồn kho.",
    minutes: 2,
    href: "/sync",
    requires: ["google"],
    lockedReason: "Cần kết nối Google Drive trước.",
  },
  {
    id: "facebook",
    ordinal: 4,
    title: "Kết nối trang Facebook",
    description: "Fanpage sẽ nhận bài đăng. Kết nối được nhiều trang.",
    minutes: 3,
    href: "/channels",
    requires: [],
    lockedReason: null,
  },
  {
    id: "group",
    ordinal: 5,
    title: "Tạo nhóm kênh",
    description: "Gom các trang hay đăng cùng nhau để chọn một lần.",
    minutes: 1,
    href: "/channels/groups",
    requires: ["facebook"],
    lockedReason: "Cần kết nối ít nhất một trang Facebook trước.",
  },
  {
    id: "firstPost",
    ordinal: 6,
    title: "Đăng bài đầu tiên",
    description: "Chọn sản phẩm, để AI viết caption, duyệt rồi đăng.",
    minutes: 2,
    href: "/compose",
    requires: ["source", "facebook"],
    lockedReason: "Cần nối Google Sheet sản phẩm và kết nối trang Facebook trước.",
  },
];

/**
 * `action.onAction` is a no-op here and `href` carries the destination:
 * navigation belongs to the component that renders the row, and a row that is
 * a real link beats a button pretending to be one.
 */
export function buildStepViews(progress: SetupProgress): readonly StepView[] {
  return SETUP_STEP_PRESENTATION.map((step) => {
    const isDone = stepFlag(progress, step.id);
    // A finished step is never locked, whatever its prerequisites now say:
    // disconnecting Google later must not un-finish a sheet already chosen.
    const isLocked = !isDone && step.requires.some((id) => !stepFlag(progress, id));
    const state: StepState = isDone ? "done" : isLocked ? "locked" : "current";

    // A dead button with no sentence beside it teaches the operator nothing
    // (Named Status Rule) — the reason goes on the ROW as well as the action.
    const reason = isLocked ? step.lockedReason : null;

    return {
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      description: step.description,
      href: step.href,
      state,
      detail: isDone ? "Đã xong" : (reason ?? `${step.minutes} ph`),
      isOptional: false,
      action: {
        label: isDone ? "Xem lại" : "Mở bước này",
        onAction: () => {},
        isBusy: false,
        disabledReason: reason,
      },
    } satisfies StepView;
  });
}
