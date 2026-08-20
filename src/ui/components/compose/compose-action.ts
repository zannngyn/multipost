/**
 * Label, availability and explanation of the ONE action on the compose screen
 * (template line 129, "Đăng luôn").
 *
 * Pure and on its own so "why can I not press this" is decided in one testable
 * place, right next to where the button is dimmed. The two drifting apart is
 * what leaves an operator staring at a dead button with no sentence beside it.
 *
 * ORDER MATTERS. The checks run from the thing that blocks everything to the
 * thing the operator can fix in one click:
 *   1. support mode — read-only, nothing below it can be true anyway;
 *   2. no Page connected — a tenant-level setup problem, not this post's;
 *   3. no product composed — nothing to publish;
 *   4. no channel ticked — nothing to publish to;
 *   5. a ticked channel with no caption — named, so the right tab gets opened.
 */
export interface ComposeActionState {
  /** Support mode (M3.3). Checked FIRST: nothing else matters when writing is off. */
  readonly readOnlyReason?: string | null;
  /** The tenant has at least one Facebook Page to publish to. */
  readonly hasChannels: boolean;
  readonly hasComposed: boolean;
  /** How many channels are ticked right now. */
  readonly channels: number;
  /**
   * Ticked channels with no caption at all, BY NAME.
   *
   * Named rather than counted on purpose: "Camilla chưa có caption" tells the
   * operator which tab to open, "1 kênh thiếu caption" makes them hunt.
   */
  readonly missingCaptionChannels?: readonly string[];
  /** The publish form's own verdict — the last word once nothing is missing. */
  readonly canSubmit: boolean;
}

export function describeAction(state: ComposeActionState): {
  enabled: boolean;
  note: string;
} {
  if (state.readOnlyReason) return { enabled: false, note: state.readOnlyReason };
  if (!state.hasChannels) {
    return {
      enabled: false,
      note: "Chưa có Page nào — kết nối Facebook ở màn Kênh trước khi đăng.",
    };
  }
  if (!state.hasComposed) return { enabled: false, note: "Tra một mã sản phẩm trước." };
  if (state.channels === 0) return { enabled: false, note: "Chọn ít nhất một kênh." };

  const missing = state.missingCaptionChannels ?? [];
  if (missing.length > 0) {
    return {
      enabled: false,
      note:
        missing.length === 1
          ? `${missing[0]} chưa có caption.`
          : `${missing.length} kênh chưa có caption: ${missing.join(", ")}.`,
    };
  }
  return { enabled: state.canSubmit, note: `${state.channels} kênh · 1 bài` };
}
