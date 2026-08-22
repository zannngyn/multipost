/**
 * The sentences a prompt-screen control says while it is temporarily off.
 *
 * They live together because they are a SYSTEM, not three strings: /prompts has
 * two writes — saving a new version and activating one — and each must lock the
 * other for the length of its request. "Lưu" may carry `activate: true`, so two
 * in-flight writes are two answers to "bản nào đang chạy", decided by whichever
 * response lands last.
 *
 * Every one of them is also load-bearing mechanically: Astryx keeps a disabled
 * control focusable (`aria-disabled` instead of native `disabled`) only when it
 * has a message to reach. A control switched off silently while it holds focus
 * drops the keyboard on <body> for the whole request — and the control that gets
 * switched off is, by definition, the one just pressed.
 */

/** Inside the create panel, about the panel's OWN save. */
export const SAVING_THIS_VERSION = "Đang lưu phiên bản…";

/** In the version table, about a save happening in the panel above it. */
export const SAVING_ELSEWHERE = "Đang lưu phiên bản mới — chờ lưu xong đã.";

/** Anywhere, about an activation in flight — including back in the panel. */
export const ACTIVATING_VERSION = "Đang đổi bản đang dùng…";
