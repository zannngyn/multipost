/**
 * Sau câu hỏi cuối, luồng đứng ở đâu — hàm THUẦN, tách khỏi component vì đây là
 * chỗ duy nhất trong task này có thể sai một cách im lặng.
 *
 * Ba đường ra, và cả ba đều đã tồn tại trước khi có màn chúc mừng:
 *
 *   `flow`      — vẫn đang hỏi, hoặc lời gọi `finish` còn đang bay;
 *   `celebrate` — vừa hoàn tất TRONG phiên này, chưa bàn giao;
 *   `leave`     — đi vào app.
 *
 * CÁI PHÂN BIỆT `celebrate` VỚI `leave` KHÔNG PHẢI `completedAt` HIỆN TẠI. Một
 * tenant hoàn tất từ tuần trước gõ `/onboarding` cũng có `completedAt` khác
 * null, và chúc mừng họ lần nữa là nói dối.
 *
 * THỨ PHÂN BIỆT LÀ HAI ẢNH CHỤP DỮ LIỆU, KHÔNG PHẢI MỘT CỜ ĐẶT ĐÚNG LÚC. Bản
 * đầu tiên của hàm này nhận `justFinished` — một latch mà `OnboardingFlow` phải
 * bật đồng bộ TRƯỚC lời `await finish.mutateAsync()`, vì `onSuccess` của
 * mutation ghi vào cache ngay bên trong lời await ấy và gây một lần render
 * trước dòng lệnh kế tiếp. Bật muộn một dòng là màn chúc mừng không bao giờ
 * hiện — không lỗi, không log, và chỉ thỉnh thoảng trên máy nhanh.
 *
 * Cách này không có cửa sổ nào để lỡ: "vừa hoàn tất" = `completedAt` LÚC MỚI
 * VÀO là null, còn BÂY GIỜ thì không. Hai giá trị, cùng một nguồn, không phụ
 * thuộc vào thứ tự các lời gọi.
 */

export interface CelebrateDecisionInput {
  /** `completed_at` như cache đang giữ, ngay lúc này. */
  readonly completedAt: string | null;
  /**
   * `completed_at` ở lần ĐẦU TIÊN component này đọc được hồ sơ.
   *
   * `undefined` = hồ sơ chưa về lần nào. `null` = lúc vào, khảo sát còn mở —
   * và đó là điều kiện duy nhất khiến việc đóng nó về sau đáng ăn mừng.
   */
  readonly completedAtOnArrival: string | null | undefined;
  /** Cú bàn giao đã bắt đầu: quyết định đi đã chốt, không rút lại được. */
  readonly hasHandedOff: boolean;
}

export type CelebrateDecision = "flow" | "celebrate" | "leave";

export function decideCelebrate({
  completedAt,
  completedAtOnArrival,
  hasHandedOff,
}: CelebrateDecisionInput): CelebrateDecision {
  // --- Edge case trước -----------------------------------------------------
  // Đã quyết định đi thì không có gì kéo lại được. Điều hướng lúc này đang bay;
  // vẽ lại màn chúc mừng sẽ nháy một khung hình của thứ vừa mờ đi xong.
  if (hasHandedOff) return "leave";

  // Khảo sát chưa đóng — kể cả khi `finish` đang bay. Trong quãng đó nút vẫn
  // đang hiện "Đang lưu…", và đó là phản hồi đúng.
  if (completedAt === null) return "flow";

  // Đóng rồi. Chỉ ăn mừng nếu lúc mới vào nó còn mở.
  //
  // `undefined` rơi vào nhánh dưới chứ không phải nhánh này, và đó là chủ ý:
  // hồ sơ chưa đọc được lần nào mà đã thấy `completedAt` nghĩa là nó đã đóng
  // từ trước khi màn hình này tồn tại.
  if (completedAtOnArrival === null) return "celebrate";

  return "leave";
}
