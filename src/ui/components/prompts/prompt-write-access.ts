/**
 * Read-only vs busy on the prompt screen — two states that must never be
 * collapsed into one, and the rule kept out of the component so it stays
 * testable in the node environment this repo runs (same reasoning as
 * `ui/hooks/read-only-gate.ts`).
 *
 * WHY THIS EXISTS. `writeGate()` folds both into a single `isDisabled`, which
 * is exactly right for a BUTTON: off is off, and the operator does not care
 * which of the two reasons is doing it. It is exactly wrong for anything that
 * decides what is MOUNTED. `isDisabled` turns true while a create is in flight,
 * so a form gated on it unmounts mid-submit: the refusal comes back to an empty
 * panel, the typed text is gone, the save spinner never renders, and the
 * first-run copy starts claiming "phiên này chỉ xem" to someone who is simply
 * waiting for a response.
 *
 *   READ-ONLY — support mode (M3.3). Permanent for this session, so it HIDES
 *   write surfaces and always carries its reason.
 *   BUSY — a write of ours is in flight. Temporary, so it only disables a
 *   control and shows a spinner; it never changes a sentence and never
 *   unmounts anything.
 */

export interface PromptWriteAccess {
  /** Support mode: nothing the operator does here will be accepted. */
  readonly isReadOnly: boolean;
  /** The sentence to show wherever a write surface is missing. */
  readonly reason: string | null;
}

/** A blank/whitespace reason is not a reason — treat it as "writes allowed". */
export function promptWriteAccess(readOnlyReason: string | null | undefined): PromptWriteAccess {
  const isReadOnly = typeof readOnlyReason === "string" && readOnlyReason.trim().length > 0;
  return { isReadOnly, reason: isReadOnly ? readOnlyReason.trim() : null };
}

/**
 * Whether the create panel is on screen. `isBusy` is accepted ONLY so this
 * function can state, and a test can pin, that it changes nothing.
 */
export function showsCreatePanel(input: {
  formOpen: boolean;
  isReadOnly: boolean;
  isBusy: boolean;
}): boolean {
  return input.formOpen && !input.isReadOnly;
}

const FIRST_RUN_WRITABLE =
  "Hệ thống đang chạy mẫu prompt mặc định đi kèm sản phẩm. Tạo phiên bản riêng khi muốn đổi giọng văn, độ dài hay cách gắn hashtag.";
const FIRST_RUN_READ_ONLY_FALLBACK = "Phiên này chỉ xem, không tạo phiên bản được.";

/**
 * First-run copy. Only a read-only session gets the read-only sentence — a
 * session that is merely waiting for the server is still allowed to write, and
 * telling it otherwise is a lie that outlives the request.
 */
export function firstRunDescription(access: PromptWriteAccess): string {
  if (!access.isReadOnly) return FIRST_RUN_WRITABLE;
  return `Hệ thống đang chạy mẫu prompt mặc định đi kèm sản phẩm. ${
    access.reason ?? FIRST_RUN_READ_ONLY_FALLBACK
  }`;
}
