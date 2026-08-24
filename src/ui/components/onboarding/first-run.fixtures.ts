import type {
  FirstRunChecklistProps,
  OperatorWaitingProps,
  StepView,
} from "./first-run.types";

/**
 * Fixture 1: Kịch bản Đang thiết lập dở dang (Bước 1 xong, Bước 2 xong, Bước 3 đang chạy, Bước 4 khóa, Bước 5 tùy chọn)
 */
export const stepsInProgressFixture: readonly StepView[] = [
  {
    id: "google",
    ordinal: 1,
    title: "Nối tài khoản Google Drive",
    description: "Cho phép hệ thống đọc thư mục ảnh mẫu và bảng tính Google Sheet quản lý sản phẩm.",
    state: "done",
    detail: "Đã kết nối tài khoản: xuongananh.fashion@gmail.com",
    isOptional: false,
    action: {
      label: "Đổi tài khoản",
      onAction: () => console.log("Action: đổi tài khoản Google"),
      isBusy: false,
      disabledReason: null,
    },
  },
  {
    id: "source",
    ordinal: 2,
    title: "Chọn thư mục ảnh & bảng Sheet",
    description: "Chỉ định thư mục 'Ảnh AI' trên Drive và bảng Sheet 'Hàng thiết kế 2026' (tab Mẫu 2026).",
    state: "done",
    detail: "Nguồn: Thư mục 'Ảnh AI 2026' / Tab 'Mẫu 2026'",
    isOptional: false,
    action: {
      label: "Đổi nguồn",
      onAction: () => console.log("Action: đổi nguồn dữ liệu"),
      isBusy: false,
      disabledReason: null,
    },
  },
  {
    id: "sync",
    ordinal: 3,
    title: "Đồng bộ sản phẩm lần đầu",
    description: "Hệ thống quét ảnh từ Drive, đối chiếu mã màu trên Sheet và kiểm tra tồn kho ban đầu.",
    state: "running",
    detail: "Đang quét 5.500 file ảnh trên Drive và đọc bảng tính... Bạn có thể rời trang, tiến trình vẫn chạy ngầm.",
    isOptional: false,
    action: {
      label: "Đang đồng bộ...",
      onAction: () => console.log("Action: sync"),
      isBusy: true,
      disabledReason: null,
    },
  },
  {
    id: "channels",
    ordinal: 4,
    title: "Kết nối Fanpage Facebook",
    description: "Chọn các Trang Facebook bạn muốn đăng bài bán hàng tự động qua AI.",
    state: "locked",
    detail: "Cần hoàn thành đồng bộ sản phẩm ở Bước 3 trước khi kết nối kênh đăng.",
    isOptional: false,
    action: {
      label: "Kết nối Facebook",
      onAction: () => console.log("Action: connect fb"),
      isBusy: false,
      disabledReason: "Đang đợi đồng bộ sản phẩm hoàn tất",
    },
  },
  {
    id: "invites",
    ordinal: 5,
    title: "Mời thành viên cùng làm việc",
    description: "Tạo link mời để nhân viên biên tập (editor) có thể vào soạn và duyệt bài cùng bạn.",
    state: "locked",
    detail: "Tùy chọn: có thể tạo link mời bất kỳ lúc nào sau khi hoàn tất.",
    isOptional: true,
    action: {
      label: "Tạo link mời",
      onAction: () => console.log("Action: invite"),
      isBusy: false,
      disabledReason: null,
    },
  },
];

/**
 * Fixture 2: Kịch bản Có bước bị Lỗi (Bước 3 bị lỗi format Sheet, Bước 4 bị khóa)
 */
export const stepsWithErrorFixture: readonly StepView[] = [
  {
    id: "google",
    ordinal: 1,
    title: "Nối tài khoản Google Drive",
    description: "Cho phép hệ thống đọc thư mục ảnh mẫu và bảng tính Google Sheet quản lý sản phẩm.",
    state: "done",
    detail: "Đã kết nối tài khoản: xuongananh.fashion@gmail.com",
    isOptional: false,
    action: null,
  },
  {
    id: "source",
    ordinal: 2,
    title: "Chọn thư mục ảnh & bảng Sheet",
    description: "Chỉ định thư mục 'Ảnh AI' trên Drive và bảng Sheet 'Hàng thiết kế 2026' (tab Mẫu 2026).",
    state: "done",
    detail: "Nguồn: Thư mục 'Ảnh AI' / Tab 'Mẫu 2026'",
    isOptional: false,
    action: null,
  },
  {
    id: "sync",
    ordinal: 3,
    title: "Đồng bộ sản phẩm lần đầu",
    description: "Hệ thống quét ảnh từ Drive, đối chiếu mã màu trên Sheet và kiểm tra tồn kho ban đầu.",
    state: "error",
    detail: "Lỗi đồng bộ (SHEET_ERROR): Tab 'Mẫu 2026' thiếu cột bắt buộc 'Mã sản phẩm'. Vui lòng kiểm tra lại cấu trúc Sheet.",
    isOptional: false,
    action: {
      label: "Thử đồng bộ lại",
      onAction: () => console.log("Action: retry sync"),
      isBusy: false,
      disabledReason: null,
    },
  },
  {
    id: "channels",
    ordinal: 4,
    title: "Kết nối Fanpage Facebook",
    description: "Chọn các Trang Facebook bạn muốn đăng bài bán hàng tự động qua AI.",
    state: "current",
    detail: null,
    isOptional: false,
    action: {
      label: "Kết nối Facebook",
      onAction: () => console.log("Action: connect fb"),
      isBusy: false,
      disabledReason: null,
    },
  },
  {
    id: "invites",
    ordinal: 5,
    title: "Mời thành viên cùng làm việc",
    description: "Tạo link mời để nhân viên biên tập (editor) có thể vào soạn và duyệt bài cùng bạn.",
    state: "locked",
    detail: null,
    isOptional: true,
    action: {
      label: "Tạo link mời",
      onAction: () => console.log("Action: invite"),
      isBusy: false,
      disabledReason: null,
    },
  },
];

/**
 * Fixture 3: Kịch bản Hoàn thành 100% (Đủ điều kiện soạn bài ngay)
 */
export const stepsCompletedFixture: readonly StepView[] = [
  {
    id: "google",
    ordinal: 1,
    title: "Nối tài khoản Google Drive",
    description: "Cho phép hệ thống đọc thư mục ảnh mẫu và bảng tính Google Sheet quản lý sản phẩm.",
    state: "done",
    detail: "Đã kết nối tài khoản: xuongananh.fashion@gmail.com",
    isOptional: false,
    action: null,
  },
  {
    id: "source",
    ordinal: 2,
    title: "Chọn thư mục ảnh & bảng Sheet",
    description: "Chỉ định thư mục 'Ảnh AI' trên Drive và bảng Sheet 'Hàng thiết kế 2026' (tab Mẫu 2026).",
    state: "done",
    detail: "Nguồn: Thư mục 'Ảnh AI 2026' / Tab 'Mẫu 2026'",
    isOptional: false,
    action: null,
  },
  {
    id: "sync",
    ordinal: 3,
    title: "Đồng bộ sản phẩm lần đầu",
    description: "Hệ thống quét ảnh từ Drive, đối chiếu mã màu trên Sheet và kiểm tra tồn kho ban đầu.",
    state: "done",
    detail: "Đồng bộ thành công: 248 mã sản phẩm hợp lệ sẵn sàng soạn bài.",
    isOptional: false,
    action: null,
  },
  {
    id: "channels",
    ordinal: 4,
    title: "Kết nối Fanpage Facebook",
    description: "Chọn các Trang Facebook bạn muốn đăng bài bán hàng tự động qua AI.",
    state: "done",
    detail: "Đã kết nối 3 Fanpage hoạt động (An Anh Boutique, Xưởng May An Anh, Thời Trang Thiết Kế).",
    isOptional: false,
    action: null,
  },
  {
    id: "invites",
    ordinal: 5,
    title: "Mời thành viên cùng làm việc",
    description: "Tạo link mời để nhân viên biên tập (editor) có thể vào soạn và duyệt bài cùng bạn.",
    state: "done",
    detail: "Đã tạo 1 link mời nhân viên biên tập.",
    isOptional: true,
    action: {
      label: "Tạo thêm link mời",
      onAction: () => console.log("Action: create more invite"),
      isBusy: false,
      disabledReason: null,
    },
  },
];

export const checklistInProgressProps: FirstRunChecklistProps = {
  steps: stepsInProgressFixture,
  doneCount: 2,
  requiredCount: 4,
  isReady: false,
  onCompose: () => alert("Điều hướng tới /compose"),
  blockError: null,
  isLoading: false,
};

export const checklistErrorProps: FirstRunChecklistProps = {
  steps: stepsWithErrorFixture,
  doneCount: 2,
  requiredCount: 4,
  isReady: false,
  onCompose: () => alert("Điều hướng tới /compose"),
  blockError: null,
  isLoading: false,
};

export const checklistReadyProps: FirstRunChecklistProps = {
  steps: stepsCompletedFixture,
  doneCount: 4,
  requiredCount: 4,
  isReady: true,
  onCompose: () => alert("Điều hướng tới /compose"),
  blockError: null,
  isLoading: false,
};

export const checklistLoadingProps: FirstRunChecklistProps = {
  steps: [],
  doneCount: 0,
  requiredCount: 4,
  isReady: false,
  onCompose: () => {},
  blockError: null,
  isLoading: true,
};

export const checklistBlockErrorRetryProps: FirstRunChecklistProps = {
  steps: [],
  doneCount: 0,
  requiredCount: 4,
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
  requiredCount: 4,
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
