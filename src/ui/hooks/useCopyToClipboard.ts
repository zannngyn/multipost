"use client";

import { useEffect, useState } from "react";

/**
 * Copying one short string, with the failure branch the browser actually has.
 *
 * `navigator.clipboard` is permission-gated: it is absent on an insecure origin
 * and blockable by permissions policy. A button that calls it and then sets
 * "đã chép" unconditionally reports success for a copy that never happened —
 * the operator pastes whatever was in the clipboard before into a support chat,
 * and nobody finds out until the batch id turns out to be the wrong one.
 *
 * The shape follows `CopyInviteUrl` (ui/components/members/InvitePanel.tsx),
 * which had this right first; it moved here once a second screen needed it.
 * Two differences are deliberate:
 *  - the caller passes a `logContext`, so a failure line carries the batch or
 *    job id instead of being an anonymous "copy failed";
 *  - the reset timer lives in an effect keyed on the state, so a component
 *    unmounted inside that window does not set state after it is gone.
 */

export type CopyState = "idle" | "copied" | "failed";

/** How long the "đã chép" / failure line stays before the button goes quiet. */
const RESET_MS = 4_000;

export interface UseCopyToClipboard {
  readonly state: CopyState;
  /** Never throws — every branch ends in a state the UI can render. */
  readonly copy: (value: string) => Promise<void>;
}

export function useCopyToClipboard(
  scope: string,
  logContext: Record<string, unknown> = {},
): UseCopyToClipboard {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), RESET_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy(value: string): Promise<void> {
    // Edge cases first: an empty value is not a copy, and reporting one would be
    // the same lie in a smaller costume.
    if (value.length === 0) {
      console.error(`[${scope}] refused to copy an empty value`, {
        ...logContext,
        error_code: "CLIPBOARD_EMPTY_VALUE",
      });
      setState("failed");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      console.error(`[${scope}] clipboard unavailable`, {
        ...logContext,
        error_code: "CLIPBOARD_UNAVAILABLE",
      });
      setState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch (error) {
      // Never swallowed: without this the button would look like it worked.
      console.error(`[${scope}] copy failed`, {
        ...logContext,
        error_code: "CLIPBOARD_DENIED",
        err: error,
      });
      setState("failed");
    }
  }

  return { state, copy };
}

/**
 * The sentence beside the button. Failure names the way out — the value is on
 * screen and can be selected by hand — instead of only saying that it failed.
 */
export function copyStatusMessage(state: CopyState, what: string): string {
  if (state === "copied") return `Đã chép ${what}.`;
  if (state === "failed") {
    return `Trình duyệt không cho chép tự động — hãy bôi đen ${what} ở trên rồi chép tay.`;
  }
  return "";
}
