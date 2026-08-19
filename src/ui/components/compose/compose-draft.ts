import type { ComposeDraftPayload, ComposeDraftStep } from "@/ui/schemas/post-draft.schema";

/**
 * Pure logic of the compose draft (E10). No React, no storage, no network —
 * every decision that is easy to get subtly wrong lives here where it can be
 * tested directly:
 *
 *  - which copy wins when the server and this machine both hold a draft,
 *  - whether a saved album arrangement still describes the album that came back,
 *  - what a draft is made of, and when it is worth saving at all.
 *
 * The hooks own the timers and the effects; this file owns the rules.
 */

export type ComposeDraftSource = "server" | "local";

export interface PickedComposeDraft {
  readonly payload: ComposeDraftPayload;
  readonly source: ComposeDraftSource;
}

/** `savedAt` as a number; an unparseable stamp sorts oldest instead of throwing. */
function savedAtMs(payload: ComposeDraftPayload): number {
  const parsed = Date.parse(payload.savedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The newer of the two copies.
 *
 * The buffer wins ties-plus-one, the server wins an exact tie: the server is the
 * source of truth, and a local copy only exists to cover the seconds between two
 * autosaves. Picking the local copy on an equal stamp would let a machine whose
 * clock runs fast keep resurrecting its own version.
 */
export function pickNewerDraft(
  server: ComposeDraftPayload | null,
  local: ComposeDraftPayload | null,
): PickedComposeDraft | null {
  if (!server && !local) return null;
  if (!server) return local ? { payload: local, source: "local" } : null;
  if (!local) return { payload: server, source: "server" };

  return savedAtMs(local) > savedAtMs(server)
    ? { payload: local, source: "local" }
    : { payload: server, source: "server" };
}

export interface AlbumOrderResult<T> {
  /** The rearranged album, or null when the saved order no longer applies. */
  readonly album: T[] | null;
  /** Operator-facing reason, present only when the order was dropped. */
  readonly notice: string | null;
}

/**
 * Re-applies a saved publish order to the album that just came back from
 * compose, matching on the media id.
 *
 * It is all-or-nothing on purpose. A partial match means files were added or
 * removed on Drive since the draft was saved, and "cover first" is the one thing
 * the arrangement exists to decide — a half-applied order could silently promote
 * the wrong photo to the cover. Dropping it and SAYING so leaves the operator
 * with the server's order and a sentence explaining why.
 */
export function applyAlbumOrder<T extends { driveFileId: string }>(
  media: readonly T[],
  order: readonly string[],
): AlbumOrderResult<T> {
  // Nothing was ever rearranged (or nothing came back): keep the server's order.
  if (order.length === 0 || media.length === 0) return { album: null, notice: null };

  const byId = new Map(media.map((asset) => [asset.driveFileId, asset]));
  const arranged: T[] = [];
  for (const id of order) {
    const asset = byId.get(id);
    if (asset) arranged.push(asset);
  }

  if (arranged.length !== media.length || arranged.length !== order.length) {
    return {
      album: null,
      notice:
        "Bộ ảnh của mã này đã thay đổi so với lúc lưu nháp, nên thứ tự bạn sắp xếp trước đó không áp lại được. Hãy kiểm tra lại thứ tự ảnh, ảnh đầu tiên là ảnh bìa.",
    };
  }

  return { album: arranged, notice: null };
}

/**
 * Whether captions typed for one product must be dropped now that another one
 * has been composed.
 *
 * THE rule, in one place, used by both paths that can change what is composed:
 * a manual re-lookup and a draft restore. A caption written for MGK-A must never
 * end up under MGK-B — and dropping one silently is just as wrong, so the caller
 * always tells the operator when this returns true.
 */
export function shouldClearCaptions(
  previousKey: string | null,
  nextKey: string,
  hasCaptions: boolean,
): boolean {
  // Nothing typed = nothing to lose; no previous identity = nothing to compare.
  if (!hasCaptions) return false;
  if (previousKey === null || previousKey.length === 0) return false;
  return previousKey !== nextKey;
}

/** Outcome of one compose attempt, as far as the captions are concerned. */
export type ComposeAttemptOutcome =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false };

/**
 * Which product the captions CURRENTLY IN THE FORM were written for, after a
 * compose attempt. The answer to `shouldClearCaptions`'s first argument, and a
 * different question from "what is composed right now".
 *
 * A refused compose (hết hàng, thiếu ảnh, mã sai) empties step 2 and 3 but does
 * NOT empty the caption fields — they are still on screen, still written for the
 * product they were written for. Forgetting that is not a cosmetic slip: with no
 * owner recorded, `shouldClearCaptions` has nothing to compare the next lookup
 * against, and a caption written for one product survives under another one.
 */
export function captionsOwnerAfterCompose(
  previousOwner: string | null,
  attempt: ComposeAttemptOutcome,
): string | null {
  if (!attempt.ok) return previousOwner;
  return attempt.key;
}

/**
 * Whether a draft that answered "đã lưu" AFTER the operator discarded it has to
 * be deleted a second time.
 *
 * Aborting a PUT only closes the socket on this side; a route handler that has
 * already taken the request can still commit its upsert after the DELETE has
 * run. When such a save comes back 2xx from before the discard, the row the
 * operator deleted is back on the server while the screen says it is gone.
 */
export function needsSecondDiscard(input: {
  /** The save left BEFORE the discard — its generation is no longer current. */
  readonly staleGeneration: boolean;
  /** True once this generation has stored something of its own. */
  readonly storedSinceDiscard: boolean;
}): boolean {
  if (!input.staleGeneration) return false;
  // The draft row is unique per (tenant, owner, kind). A save made SINCE the
  // discard has already overwritten the resurrected row with content the
  // operator can still see on screen — deleting it now would destroy live work,
  // and there is no leftover row to delete anyway.
  if (input.storedSinceDiscard) return false;
  return true;
}

/**
 * Which step a restored draft may land on.
 *
 * Two gates, both non-negotiable:
 *  - compose refused (hết hàng, không có ảnh, mã đã đổi) → step 1, always. Step
 *    2 and 3 describe a post that does not exist, and showing them with the old
 *    draft's data is exactly the "replay a stale answer" this feature forbids;
 *  - step 3 needs a caption for every channel, the same gate the footer uses.
 */
export function restoreTargetStep(input: {
  composed: boolean;
  draftStep: ComposeDraftStep;
  everyCaption: boolean;
}): ComposeDraftStep {
  if (!input.composed) return "san-pham";
  if (input.draftStep === "xem-lai" && !input.everyCaption) return "caption";
  return input.draftStep;
}

export interface ComposeDraftSnapshot {
  step: ComposeDraftStep;
  /**
   * Identity the stored captions belong to (`captionsOwnerAfterCompose`), NOT
   * "what was composed last". A draft can hold captions for a product whose
   * compose has since been refused, and the restore has to be able to tell.
   */
  composeKey: string;
  productCode: string;
  color: string;
  mediaKind: ComposeDraftPayload["mediaKind"];
  videoTarget: ComposeDraftPayload["videoTarget"];
  source: ComposeDraftPayload["source"];
  captions: Record<string, string>;
  captionOverrides: Record<string, string>;
  albumOrder: readonly string[];
  selectedChannelIds: readonly string[];
  shareCaption: boolean;
  schedule: ComposeDraftPayload["schedule"];
}

/**
 * Builds the payload from what is on screen.
 *
 * The whitelist is enforced by CONSTRUCTION: this function names every field it
 * copies, so there is no path by which a composed product, a stock number or a
 * signed URL can reach the draft — even if a future field appears next to them
 * in the wizard state.
 *
 * Empty entries are dropped rather than stored: an untouched channel override or
 * a blank caption is not a value the operator chose, and keeping them would grow
 * the payload towards the 64 KiB ceiling for nothing.
 */
export function buildComposeDraftPayload(
  snapshot: ComposeDraftSnapshot,
  savedAtMsValue: number = Date.now(),
): ComposeDraftPayload {
  return {
    step: snapshot.step,
    composeKey: snapshot.composeKey,
    productCode: snapshot.productCode,
    color: snapshot.color,
    mediaKind: snapshot.mediaKind,
    videoTarget: snapshot.videoTarget,
    source: snapshot.source,
    captions: withoutEmptyValues(snapshot.captions),
    captionOverrides: withoutEmptyValues(snapshot.captionOverrides),
    albumOrder: [...snapshot.albumOrder].filter((id) => id.length > 0),
    selectedChannelIds: [...snapshot.selectedChannelIds].filter((id) => id.length > 0),
    shareCaption: snapshot.shareCaption,
    schedule: { mode: snapshot.schedule.mode, value: snapshot.schedule.value },
    savedAt: new Date(
      Number.isFinite(savedAtMsValue) ? savedAtMsValue : Date.now(),
    ).toISOString(),
  };
}

function withoutEmptyValues(record: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key.length > 0 && typeof value === "string" && value.trim().length > 0) kept[key] = value;
  }
  return kept;
}

/**
 * True when the draft holds something the operator would miss.
 *
 * Opening the screen and walking away must not create a row: a draft nobody
 * typed is noise in the table and, worse, something to "restore" on the next
 * visit. The moment anything real is on screen, autosave starts.
 */
export function isDraftWorthSaving(payload: ComposeDraftPayload): boolean {
  if (payload.productCode.trim().length > 0) return true;
  if (payload.albumOrder.length > 0) return true;
  if (payload.selectedChannelIds.length > 0) return true;
  if (payload.schedule.mode === "scheduled") return true;
  if (Object.values(payload.captions).some((text) => text.trim().length > 0)) return true;
  return Object.values(payload.captionOverrides).some((text) => text.trim().length > 0);
}

/**
 * Whether two drafts differ in CONTENT. `savedAt` is excluded: it changes on
 * every render, and comparing it would make autosave fire forever on a screen
 * nobody is touching.
 */
export function draftContentDiffers(
  previous: ComposeDraftPayload | null,
  next: ComposeDraftPayload,
): boolean {
  if (!previous) return true;
  return draftContentKey(previous) !== draftContentKey(next);
}

/**
 * Stable string identity of a draft's CONTENT — also the dependency autosave
 * watches, so the debounce restarts on a real change and not on a re-render.
 */
export function draftContentKey(payload: ComposeDraftPayload): string {
  const { savedAt: _savedAt, ...content } = payload;
  return JSON.stringify(content);
}

// --- Caption ownership ------------------------------------------------------
/**
 * WHO the text on screen was written for, carried WITH the text.
 *
 * `form.captions` has an owner (`captionsOwnerRef` in useComposeWizard). The
 * per-channel overrides in `usePublishForm` had none, and that was a hole with
 * exactly the shape the owner ref exists to close: an override typed for MGK-A
 * stayed in state while the operator looked up MGK-B, and — with "dùng chung
 * caption" off — went out as B's caption. An override IS a caption; it obeys the
 * same law.
 */
export interface OwnedCaptionText {
  /** Compose key the entries were typed under; null = they belong to nothing. */
  readonly ownerKey: string | null;
  /** channelId -> text, exactly as typed. */
  readonly byChannel: Readonly<Record<string, string>>;
}

export const EMPTY_OWNED_CAPTIONS: OwnedCaptionText = { ownerKey: null, byChannel: {} };

/**
 * Whether text typed under `ownerKey` may still be used under `currentKey`.
 *
 * Stricter than `shouldClearCaptions` on ONE point, deliberately: an absent or
 * EMPTY owner means "no right to be used", not "nothing to compare against".
 * `shouldClearCaptions` is lenient there because the caption fields are the
 * operator's own visible work in the form in front of them; an override is text
 * nobody sees until a channel box is opened, and a draft written by an older
 * build can carry one with `composeKey: ""`.
 */
export function captionTextStillOwned(
  ownerKey: string | null,
  currentKey: string | null,
): boolean {
  if (ownerKey === null || ownerKey.length === 0) return false;
  return ownerKey === currentKey;
}

/**
 * The overrides that still belong to what is composed right now.
 *
 * Returns the SAME object when nothing has to change — the publish hook calls
 * this during render and feeds the result back into its own state, so a fresh
 * object on every call would be an infinite render loop.
 */
export function ownedCaptionText(
  state: OwnedCaptionText,
  currentKey: string | null,
): OwnedCaptionText {
  // Nothing typed: keep the identity in step with the screen so the NEXT edit is
  // recorded under the product that is actually composed.
  if (Object.keys(state.byChannel).length === 0) {
    return state.ownerKey === currentKey ? state : { ownerKey: currentKey, byChannel: {} };
  }
  if (captionTextStillOwned(state.ownerKey, currentKey)) return state;
  return { ownerKey: currentKey, byChannel: {} };
}

/** Records one channel's edit under the product on screen, dropping any stale set. */
export function withCaptionOverride(
  state: OwnedCaptionText,
  currentKey: string | null,
  channelId: string,
  text: string,
): OwnedCaptionText {
  const owned = ownedCaptionText(state, currentKey);
  return { ownerKey: currentKey, byChannel: { ...owned.byChannel, [channelId]: text } };
}

/**
 * THE text that goes out on one channel — the last gate before `createBatch`.
 *
 * The ownership check lives HERE, at the call site that publishes, not only
 * where the state is pruned: a leak on this path does not lose a draft, it puts
 * one product's caption under another product's photos on Facebook. If pruning
 * ever misses a case, this still cannot send it.
 *
 * An override that is present but EMPTY returns empty on purpose: the operator
 * cleared that box, and `submit` must report the channel as missing a caption
 * rather than quietly publish the shared one.
 */
export function captionForChannel(input: {
  readonly channelId: string;
  readonly baseCaption: string;
  readonly shareCaption: boolean;
  readonly overrides: OwnedCaptionText;
  /** Compose key the captions on screen belong to; null = nothing composed. */
  readonly currentKey: string | null;
}): string {
  if (input.shareCaption) return input.baseCaption.trim();
  const owned = ownedCaptionText(input.overrides, input.currentKey);
  return (owned.byChannel[input.channelId] ?? input.baseCaption).trim();
}

/** Said out loud when a draft's captions are dropped for having no owner. */
export const UNOWNED_DRAFT_CAPTIONS_NOTICE =
  "Nháp cũ không ghi lại caption thuộc mã sản phẩm nào, nên caption trong nháp đã bị bỏ để không đăng nhầm sang mã khác. Hãy viết lại caption ở bước 2.";

export interface RestorableDraftCaptions {
  /** Owner to stamp the restored text with; null when nothing may be restored. */
  readonly ownerKey: string | null;
  readonly captions: Record<string, string>;
  readonly captionOverrides: Record<string, string>;
  readonly notice: string | null;
}

/**
 * What a stored draft is allowed to put back in the caption fields.
 *
 * The dangerous row is the one an OLDER build wrote: `composeKey: ""` together
 * with captions. Those rows are in the database right now — they are the output
 * of the bug this feature is fixing — the schema version still accepts them, and
 * the server copy has no TTL, so they WILL be offered back. Restoring their
 * captions puts text written for one product on screen with no owner recorded,
 * and the next lookup then has nothing to compare against.
 *
 * Safe default: captions with no owner are DROPPED, and the operator is told.
 * Losing a caption costs one "viết lại"; keeping it can cost a wrong post.
 */
export function restorableDraftCaptions(
  draft: Pick<ComposeDraftPayload, "composeKey" | "captions" | "captionOverrides">,
): RestorableDraftCaptions {
  const ownerKey = (draft.composeKey ?? "").trim();
  const captions = withoutEmptyValues(draft.captions ?? {});
  const captionOverrides = withoutEmptyValues(draft.captionOverrides ?? {});

  if (ownerKey.length > 0) return { ownerKey, captions, captionOverrides, notice: null };

  const hadText = Object.keys(captions).length > 0 || Object.keys(captionOverrides).length > 0;
  return {
    ownerKey: null,
    captions: {},
    captionOverrides: {},
    // Nothing was typed = nothing was dropped = nothing to announce.
    notice: hadText ? UNOWNED_DRAFT_CAPTIONS_NOTICE : null,
  };
}

/** Said out loud when per-channel overrides are dropped for changing product. */
export const DROPPED_OVERRIDES_NOTICE =
  "Nháp có caption riêng cho từng kênh, nhưng bài đang soạn không còn là sản phẩm của nháp đó nên phần caption riêng đã bị bỏ. Hãy kiểm tra lại caption từng kênh ở bước 3 trước khi tạo lô.";

/**
 * Whether the operator has to be told that their per-channel edits are gone.
 *
 * The publish form drops them on its next render, and a drop nobody mentions is
 * the "im lặng bỏ qua" business rule 5 forbids: the boxes would simply be back
 * on the shared caption, which reads as the edit never having been saved.
 */
export function droppedOverridesNotice(input: {
  /** Overrides the draft carried, after the ownerless ones were already removed. */
  readonly overrides: Record<string, string>;
  readonly draftOwnerKey: string | null;
  /** Owner of the captions on screen once the restore has finished. */
  readonly currentKey: string | null;
}): string | null {
  if (Object.keys(input.overrides).length === 0) return null;
  if (captionTextStillOwned(input.draftOwnerKey, input.currentKey)) return null;
  return DROPPED_OVERRIDES_NOTICE;
}

// --- What one autosave leaves behind ----------------------------------------
/** How the PUT settled, as far as this screen can tell. */
export type SaveSettlement =
  | { readonly outcome: "saved" }
  /** Rejected — network, timeout, 4xx/5xx, or an abort asked for on this side. */
  | { readonly outcome: "failed"; readonly aborted: boolean };

export interface SaveAftermath {
  /** Write `lastSaved`, paint "Đã lưu" — only for a save the screen still wants. */
  readonly applyToScreen: boolean;
  /** Paint the error line. */
  readonly reportError: boolean;
  /** The server may hold a row this screen has already thrown away. */
  readonly resurrectedRow: boolean;
}

/**
 * The verdict on one finished save, for BOTH ways it can finish.
 *
 * The trap this closes: "Xoá nháp" aborts the save in flight, and an abort makes
 * the request REJECT — it does not resolve. Reading the resurrection flag only
 * out of the success branch therefore never saw the ordinary case: the DELETE
 * went out, the aborted PUT's handler committed behind it, and the row came back
 * with nobody left to delete it. On the next mount that row is offered as "nháp
 * đang soạn" of a post the operator threw away.
 *
 * So a save from a stale generation counts as a resurrection WHATEVER it
 * answered: once the socket is closed this side cannot know whether the handler
 * committed, and the two mistakes are not equal. A redundant DELETE is free —
 * discarding is idempotent (`discard-post-draft.test.ts`, "deleting twice is
 * success") — while a missed one hands back a draft that was deleted on purpose.
 */
export function saveAftermath(input: {
  readonly settlement: SaveSettlement;
  /** True when the screen moved on (discard, publish) while this save was out. */
  readonly staleGeneration: boolean;
}): SaveAftermath {
  if (input.staleGeneration) {
    return { applyToScreen: false, reportError: false, resurrectedRow: true };
  }
  if (input.settlement.outcome === "saved") {
    return { applyToScreen: true, reportError: false, resurrectedRow: false };
  }
  // An abort with the generation unchanged is still our own doing, not something
  // to put in front of the operator.
  return {
    applyToScreen: false,
    reportError: !input.settlement.aborted,
    resurrectedRow: false,
  };
}

/** Which operation the draft's error line is about — they need different retries. */
export type DraftErrorAction = "save" | "discard";

/**
 * What "Thử lại" must do.
 *
 * One button, and the last failure decides: retrying a failed DELETE by sending
 * a PUT writes back the very row the operator asked to remove.
 */
export function draftRetryAction(input: {
  /** `ComposeDraftPhase`, as a plain string — a pure rule imports no hook. */
  readonly phase: string;
  readonly errorAction: DraftErrorAction;
}): DraftErrorAction | "none" {
  if (input.phase !== "error") return "none";
  return input.errorAction;
}
