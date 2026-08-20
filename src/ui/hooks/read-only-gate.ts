/**
 * The one rule every write control follows while the app is read-only (M3.3).
 *
 * Kept free of React so it is testable in the node environment this repo runs
 * (`vitest.config.ts`: `environment: "node"`, no DOM harness) — the decision
 * "is this button off, and does it say why?" is the part that must not regress,
 * and it only stays testable while it lives outside the component
 * (same reasoning as `present-worker-health`).
 *
 * Two ways a control is off, and they are NOT the same:
 *  - BUSY: a write of its own is in flight. Temporary, self-explanatory, and
 *    the button already shows a spinner — adding a sentence would be noise.
 *  - READ-ONLY: support mode. Nothing the operator does here will ever work,
 *    so this one MUST carry its reason (core-auth-session: vô hiệu hoá luôn
 *    kèm lý do; core-feedback-states: mọi thông báo phải có lối ra).
 *
 * It is UX, never protection: the server refuses the write regardless.
 */

export interface WriteGate {
  /** Feed straight into `disabled` / `isDisabled`. */
  readonly isDisabled: boolean;
  /**
   * The sentence to render next to the control, or null when there is nothing
   * worth saying. Never a reason for "busy" — that would put a permanent
   * explanation next to a temporary state.
   */
  readonly reason: string | null;
}

export function writeGate(readOnlyReason: string | null, isBusy = false): WriteGate {
  const isReadOnly = typeof readOnlyReason === "string" && readOnlyReason.trim().length > 0;

  return {
    isDisabled: isReadOnly || isBusy,
    // Read-only wins the sentence even while busy: once the answer lands the
    // control stays off, and saying so early is not wrong.
    reason: isReadOnly ? readOnlyReason : null,
  };
}
