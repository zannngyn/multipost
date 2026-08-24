/** Bốn vai thật của hệ thống (ACCESS_ROLES). Không có "member". */
export type OnboardingRole = "owner" | "admin" | "editor" | "viewer";

/** Trạng thái THỊ GIÁC của một bước — không phải trạng thái server. */
export type StepState = "done" | "current" | "running" | "locked" | "error";

export type StepId = "google" | "source" | "sync" | "channels" | "invites";

export interface StepAction {
  readonly label: string;
  readonly onAction: () => void;
  readonly isBusy: boolean;
  /** Có lý do => nút phải mờ VÀ hiện câu này ngay cạnh (Named Status Rule). */
  readonly disabledReason: string | null;
}

export interface StepView {
  readonly id: StepId;
  readonly ordinal: 1 | 2 | 3 | 4 | 5;
  readonly title: string;
  readonly description: string;
  readonly state: StepState;
  /** Câu phụ đổi theo state: "Đã nối shop@gmail.com" · lý do khoá · câu lỗi. */
  readonly detail: string | null;
  readonly isOptional: boolean;
  readonly action: StepAction | null;
}

export interface FirstRunChecklistProps {
  readonly steps: readonly StepView[];
  readonly doneCount: number;
  readonly requiredCount: number;
  /** Đủ điều kiện soạn bài — quyết định khối "đích" hiện hay ẩn. */
  readonly isReady: boolean;
  readonly onCompose: () => void;
  /** Cả khối hỏng (không phải một bước). onRetry null = không đáng thử lại. */
  readonly blockError: { readonly message: string; readonly onRetry: (() => void) | null } | null;
  readonly isLoading: boolean;
}

export interface WaitingSignal {
  readonly label: string;
  readonly state: "waiting" | "ready";
  readonly detail: string | null;
}

export interface OperatorWaitingProps {
  readonly tenantName: string;
  readonly role: Extract<OnboardingRole, "editor" | "viewer">;
  readonly signals: readonly WaitingSignal[];
  readonly isReady: boolean;
  /** null với viewer — viewer không soạn bài. */
  readonly onCompose: (() => void) | null;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}
