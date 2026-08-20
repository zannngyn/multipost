import { z } from "zod";

import {
  ComposeDraftPayloadSchema,
  type ComposeDraftPayload,
} from "@/ui/schemas/post-draft.schema";

import { apiRequest, apiRequestNoContent } from "./http-client";

/**
 * Data layer of the compose draft (E10), docs/07 §4.1.
 * GET/PUT/DELETE /api/posts/drafts.
 *
 * Two things this module refuses to hide:
 *  - `persisted: false` — the server has no `app_user` row for this session, so
 *    nothing was stored anywhere but this machine. It is a normal state of a
 *    demo/dev environment and the screen must SAY it, not paint "Đã lưu";
 *  - a rejected payload (422 DRAFT_PAYLOAD_REJECTED / 413 DRAFT_TOO_LARGE) —
 *    that is a client bug leaking internal data or an oversized draft, and it
 *    surfaces as an ApiError like any other.
 *
 * Autosave calls this on a timer, so every request is cheap and none is retried
 * automatically: a draft is worth exactly one attempt, the next keystroke brings
 * another one.
 */

/** Autosave must never sit in a queue behind a slow link for 15 seconds. */
const DRAFT_TIMEOUT_MS = 8_000;

export const draftKeys = {
  compose: (tenantKey: string) => ["post-draft", tenantKey, "compose"] as const,
};

const DRAFT_ENDPOINT = "/api/posts/drafts";

/**
 * `draft` is parsed with the SAME schema the buffer uses: a row written by an
 * older build, or by a version of this screen that has since changed, must be
 * dropped here rather than half-applied to a form.
 */
export const ComposeDraftResponseSchema = z.object({
  draft: ComposeDraftPayloadSchema.nullable(),
  updatedAt: z.string().nullable(),
  /** False = no server-side draft for this operator ("chỉ lưu trên máy này"). */
  persisted: z.boolean(),
  /**
   * One-way hash of `app_user.id`, or null when the session maps to no operator.
   * It scopes the local buffer to the same owner the DB row belongs to, so a
   * shared machine cannot hand one operator's draft to the next one.
   */
  ownerKey: z.string().min(1).nullable(),
});
export type ComposeDraftResponse = z.infer<typeof ComposeDraftResponseSchema>;

export const SaveComposeDraftResponseSchema = z.object({
  updatedAt: z.string().nullable(),
  persisted: z.boolean(),
  /** "NO_USER" when the session e-mail matches no app_user row. */
  reason: z.string().optional(),
});
export type SaveComposeDraftResponse = z.infer<typeof SaveComposeDraftResponseSchema>;

export async function fetchComposeDraft(signal?: AbortSignal): Promise<ComposeDraftResponse> {
  return apiRequest(DRAFT_ENDPOINT, {
    schema: ComposeDraftResponseSchema,
    signal,
    timeoutMs: DRAFT_TIMEOUT_MS,
    malformedMessage:
      "Nháp trả về không đúng định dạng nên đã bị bỏ qua. Hãy soạn lại từ bước 1.",
  });
}

export async function saveComposeDraft(
  params: { payload: ComposeDraftPayload },
  signal?: AbortSignal,
): Promise<SaveComposeDraftResponse> {
  return apiRequest(DRAFT_ENDPOINT, {
    method: "PUT",
    body: { payload: params.payload },
    schema: SaveComposeDraftResponseSchema,
    signal,
    timeoutMs: DRAFT_TIMEOUT_MS,
    malformedMessage: "Không xác nhận được nháp đã lưu. Nháp vẫn được giữ trên máy này.",
  });
}

export async function discardComposeDraft(signal?: AbortSignal): Promise<void> {
  await apiRequestNoContent(DRAFT_ENDPOINT, {
    method: "DELETE",
    signal,
    timeoutMs: DRAFT_TIMEOUT_MS,
  });
}

/**
 * Last-gasp save while the tab is going away (`pagehide` / hidden).
 *
 * A normal `fetch` is cancelled when the document unloads, which is exactly the
 * moment the draft matters most. Two escape hatches, in order:
 *  1. `navigator.sendBeacon` — queued by the browser and sent after the page is
 *     gone. It can only POST, which is why the route also accepts POST;
 *  2. `fetch(..., { keepalive: true })` — same idea, wider method support, but
 *     not implemented everywhere.
 *
 * Returns whether a request was handed over. `false` means the buffer on this
 * machine is the only copy — the caller has already written it.
 */
export function beaconComposeDraft(params: { payload: ComposeDraftPayload }): boolean {
  if (typeof window === "undefined") return false;

  const body = JSON.stringify({ payload: params.payload });

  try {
    // `text/plain` avoids a CORS preflight the unloading page would not survive;
    // the route reads the body itself and never looks at the content type.
    const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // Returns false when the payload is over the browser's beacon quota.
      if (navigator.sendBeacon(DRAFT_ENDPOINT, blob)) return true;
    }

    void fetch(DRAFT_ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store",
    }).catch((cause: unknown) => {
      // Nothing to show: the page is unloading. Logged so a systematic failure
      // is visible in a devtools session that survives the navigation.
      console.warn("[draft.api] keepalive draft flush failed", {
        scope: "ui/draft.api",
        action: "beacon",
        errorName: cause instanceof Error ? cause.name : undefined,
      });
    });
    return true;
  } catch (cause) {
    console.warn("[draft.api] draft flush could not be handed to the browser", {
      scope: "ui/draft.api",
      action: "beacon",
      errorName: cause instanceof Error ? cause.name : undefined,
    });
    return false;
  }
}
