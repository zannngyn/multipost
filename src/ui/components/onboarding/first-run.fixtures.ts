import type { SetupProgress, SetupStepId } from "@/ui/schemas/setup-progress.schema";

import type { FirstRunChecklistProps, OperatorWaitingProps, StepView } from "./first-run.types";
import { buildStepViews } from "./setup-steps";

/**
 * Visual fixtures for the dev preview page — its ONLY consumer.
 *
 * Built from `buildStepViews` rather than hand-written rows: a fixture that
 * invents its own labels and lock reasons stops matching the screen the moment
 * either changes, and then the preview quietly lies about what the operator
 * sees. Only the two states the real mapper cannot produce — `running` and
 * `error`, which come from a live sync rather than from the six flags — are
 * patched in by hand below.
 */

const ALL_STEP_IDS: readonly SetupStepId[] = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
  "firstPost",
];

const REQUIRED_STEP_IDS: readonly SetupStepId[] = ALL_STEP_IDS.filter((id) => id !== "firstPost");

const REQUIRED_COUNT = REQUIRED_STEP_IDS.length;

function progressOf(done: Partial<Record<SetupStepId, boolean>>): SetupProgress {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    steps: ALL_STEP_IDS.map((id) => ({ id, isDone: done[id] ?? false })),
    doneCount: REQUIRED_STEP_IDS.filter((id) => done[id]).length,
    requiredCount: REQUIRED_COUNT,
    isReady: Boolean(done.source && done.facebook),
  };
}

/** Patch ONE row, leaving every other row exactly as the real mapper made it. */
function patchStep(
  steps: readonly StepView[],
  id: SetupStepId,
  patch: Partial<StepView>,
): readonly StepView[] {
  return steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
}

/** 1 — mid-setup: Drive connected, the sheet sync is running, the group still locked. */
export const stepsInProgressFixture: readonly StepView[] = patchStep(
  buildStepViews(progressOf({ tenant: true, google: true })),
  "source",
  {
    state: "running",
    detail: "Đang quét 5.500 file ảnh trên Drive và đọc bảng tính... Bạn có thể rời trang.",
    action: {
      label: "Đang đồng bộ...",
      onAction: () => {},
      isBusy: true,
      disabledReason: null,
    },
  },
);

/** 2 — the sheet step failed; the Facebook step below it is untouched and open. */
export const stepsWithErrorFixture: readonly StepView[] = patchStep(
  buildStepViews(progressOf({ tenant: true, google: true })),
  "source",
  {
    state: "error",
    detail:
      "Lỗi đồng bộ (SHEET_ERROR): tab 'Mẫu 2026' thiếu cột bắt buộc 'Mã sản phẩm'. Kiểm tra lại cấu trúc Sheet.",
    action: {
      label: "Thử đồng bộ lại",
      onAction: () => {},
      isBusy: false,
      disabledReason: null,
    },
  },
);

/** 3 — every setup step done; only the first post is still ahead. */
export const stepsCompletedFixture: readonly StepView[] = buildStepViews(
  progressOf({ tenant: true, google: true, source: true, facebook: true, group: true }),
);

export const checklistInProgressProps: FirstRunChecklistProps = {
  steps: stepsInProgressFixture,
  doneCount: 2,
  requiredCount: REQUIRED_COUNT,
  isReady: false,
  onCompose: () => alert("Điều hướng tới /compose"),
  blockError: null,
  isLoading: false,
};

export const checklistErrorProps: FirstRunChecklistProps = {
  steps: stepsWithErrorFixture,
  doneCount: 2,
  requiredCount: REQUIRED_COUNT,
  isReady: false,
  onCompose: () => alert("Điều hướng tới /compose"),
  blockError: null,
  isLoading: false,
};

export const checklistReadyProps: FirstRunChecklistProps = {
  steps: stepsCompletedFixture,
  doneCount: REQUIRED_COUNT,
  requiredCount: REQUIRED_COUNT,
  isReady: true,
  onCompose: () => alert("Điều hướng tới /compose"),
  blockError: null,
  isLoading: false,
};

export const checklistLoadingProps: FirstRunChecklistProps = {
  steps: [],
  doneCount: 0,
  requiredCount: REQUIRED_COUNT,
  isReady: false,
  onCompose: () => {},
  blockError: null,
  isLoading: true,
};

export const checklistBlockErrorRetryProps: FirstRunChecklistProps = {
  steps: [],
  doneCount: 0,
  requiredCount: REQUIRED_COUNT,
  isReady: false,
  onCompose: () => {},
  blockError: {
    message: "Không thể kết nối đến máy chủ quản lý danh tính (lỗi mạng 503). Vui lòng thử lại.",
    onRetry: () => alert("Đang thử kết nối lại..."),
  },
  isLoading: false,
};

export const checklistBlockErrorNoRetryProps: FirstRunChecklistProps = {
  steps: [],
  doneCount: 0,
  requiredCount: REQUIRED_COUNT,
  isReady: false,
  onCompose: () => {},
  blockError: {
    message: "Tài khoản của bạn đã bị đăng xuất hoặc hết hạn phiên làm việc.",
    onRetry: null,
  },
  isLoading: false,
};

/**
 * Fixtures cho OperatorWaitingCard (Nhánh Editor & Viewer)
 */
export const operatorEditorWaitingProps: OperatorWaitingProps = {
  tenantName: "Xưởng May An Anh",
  role: "editor",
  signals: [
    { label: "Nguồn dữ liệu Drive & Sheet", state: "ready", detail: "Đã nối: Mẫu 2026" },
    { label: "Mã sản phẩm trong kho", state: "waiting", detail: "Chưa đồng bộ (0 mã)" },
    { label: "Fanpage Facebook kết nối", state: "waiting", detail: "Chưa có kênh active" },
  ],
  isReady: false,
  onCompose: () => alert("Soạn bài"),
  onRefresh: () => alert("Đang kiểm tra lại..."),
  isRefreshing: false,
};

export const operatorEditorReadyProps: OperatorWaitingProps = {
  tenantName: "Xưởng May An Anh",
  role: "editor",
  signals: [
    { label: "Nguồn dữ liệu Drive & Sheet", state: "ready", detail: "Đã nối: Mẫu 2026" },
    { label: "Mã sản phẩm trong kho", state: "ready", detail: "248 mã sẵn sàng" },
    { label: "Fanpage Facebook kết nối", state: "ready", detail: "3 Fanpage active" },
  ],
  isReady: true,
  onCompose: () => alert("Điều hướng tới /compose"),
  onRefresh: () => alert("Đang kiểm tra lại..."),
  isRefreshing: false,
};

export const operatorViewerWaitingProps: OperatorWaitingProps = {
  tenantName: "Xưởng May An Anh",
  role: "viewer",
  signals: [
    { label: "Nguồn dữ liệu Drive & Sheet", state: "ready", detail: "Đã nối: Mẫu 2026" },
    { label: "Mã sản phẩm trong kho", state: "waiting", detail: "Chưa đồng bộ" },
    { label: "Fanpage Facebook kết nối", state: "waiting", detail: "Chưa có kênh" },
  ],
  isReady: false,
  onCompose: null, // Viewer không có quyền soạn bài
  onRefresh: () => alert("Đang kiểm tra lại..."),
  isRefreshing: false,
};

export const operatorViewerReadyProps: OperatorWaitingProps = {
  tenantName: "Xưởng May An Anh",
  role: "viewer",
  signals: [
    { label: "Nguồn dữ liệu Drive & Sheet", state: "ready", detail: "Đã nối: Mẫu 2026" },
    { label: "Mã sản phẩm trong kho", state: "ready", detail: "248 mã sẵn sàng" },
    { label: "Fanpage Facebook kết nối", state: "ready", detail: "3 Fanpage active" },
  ],
  isReady: true,
  onCompose: null, // Viewer không có quyền soạn bài
  onRefresh: () => alert("Đang kiểm tra lại..."),
  isRefreshing: false,
};
