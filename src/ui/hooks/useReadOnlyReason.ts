"use client";

import { useActiveTenant } from "@/ui/hooks/useMe";

/**
 * Why writing is off right now — or null when it is not (M3.3).
 *
 * Support mode is read-only (doc 09 §3.5): every write answers 403. Most
 * screens already hide their buttons because `useActiveTenant` reports the role
 * as `viewer` while a support session is open, and the M2.3 ladder does the
 * rest. This hook is for the screens that gate on something OTHER than role —
 * they disable on this reason and show it, instead of offering a button that
 * can only fail (core-auth-session: vô hiệu hoá luôn kèm lý do).
 *
 * It is UX, not protection: the server refuses regardless.
 */
export const SUPPORT_MODE_READ_ONLY_REASON =
  "Chế độ hỗ trợ chỉ được xem — bạn đang xem dữ liệu của khách, không thay đổi được gì. Thoát hỗ trợ ở thanh trên cùng để làm việc lại ở công ty của bạn.";

export function useReadOnlyReason(): string | null {
  const { isSupportMode } = useActiveTenant();
  return isSupportMode ? SUPPORT_MODE_READ_ONLY_REASON : null;
}
