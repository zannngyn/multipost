"use client";

import { useEffect, useState } from "react";

/**
 * "Người dùng vừa từ /onboarding bước vào app" — một boolean sống đúng một cú
 * điều hướng phía client, không hơn.
 *
 * MODULE SCOPE, KHÔNG PHẢI COOKIE, KHÔNG PHẢI sessionStorage.
 *
 * `router.replace("/")` là điều hướng phía client: bundle không nạp lại, nên
 * một biến ở phạm vi module sống xuyên qua cú chuyển route group. Đó đúng bằng
 * thứ cần ở đây, và nó có ba tính chất mà cookie phải dựng thêm mới có:
 *
 *   - tải lại trang là cờ mất. Đó là hành vi ĐÚNG — hiệu ứng bàn giao chỉ có
 *     nghĩa ngay sau khi khảo sát xong, không phải mỗi lần mở lại tab. Cookie
 *     phải có `Max-Age` cộng một lần tự xoá mới đạt được điều đó, và vẫn còn
 *     cửa sổ phát lại nếu lần xoá ấy hỏng;
 *   - `(app)/layout.tsx` không phải biết gì về nó. Một hiệu ứng thuần client
 *     không có lý do gì để luồn qua tầng server;
 *   - không có gì ghi ra ổ đĩa của người dùng cho một hiệu ứng 400ms.
 *
 * ĐỌC TRONG LÚC RENDER, KHÔNG PHẢI TRONG EFFECT. Class fade phải có mặt ở khung
 * hình ĐẦU TIÊN mà app vẽ; một `useEffect` chạy sau khi đã vẽ, nên app sẽ hiện
 * đủ nét một khung rồi mới mờ vào — đúng cái nháy mà toàn bộ việc này để tránh.
 */

/** Cờ. Đọc bằng `peekHandoffArrival`, đừng đọc thẳng từ ngoài module. */
let isArriving = false;

/** Onboarding gọi ngay trước `router.replace("/")`. */
export function markHandoffArrival(): void {
  isArriving = true;
}

/** Giá trị hiện tại. Tách ra thành hàm để test được ở môi trường node. */
export function peekHandoffArrival(): boolean {
  return isArriving;
}

/**
 * Tiêu thụ cờ, để lần sau quay lại "/" trong cùng tab không phát lại hiệu ứng.
 *
 * KHÔNG thông báo cho ai. Nếu nó phát tín hiệu re-render, `AppFrame` sẽ vẽ lại
 * và gỡ class ra GIỮA LÚC animation đang chạy — cú fade chết ngang. Việc tiêu
 * thụ không cần xảy ra trước khi vẽ, nên nó lặng lẽ là đúng.
 */
export function clearHandoffArrival(): void {
  isArriving = false;
}

/**
 * Dùng ở `AppFrame`. Trả về `true` đúng một lần, cho lần mount đầu tiên sau khi
 * onboarding gọi `markHandoffArrival()`.
 *
 * `useState` với initializer chứ không phải `useSyncExternalStore`: cờ này được
 * đọc MỘT LẦN rồi đóng băng cho cả vòng đời của frame. Nếu đăng ký theo dõi
 * store, lần tiêu thụ ở effect bên dưới sẽ kéo giá trị về `false` và gỡ class
 * đi khi animation mới chạy được vài khung hình.
 */
export function useHandoffArrival(): boolean {
  const [isArrival] = useState(peekHandoffArrival);

  useEffect(() => {
    clearHandoffArrival();
  }, []);

  return isArrival;
}
