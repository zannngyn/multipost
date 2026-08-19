"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWatch } from "react-hook-form";

import {
  buildComposeDraftPayload,
  draftContentKey,
  draftRetryAction,
  isDraftWorthSaving,
  needsSecondDiscard,
  pickNewerDraft,
  saveAftermath,
  type ComposeDraftSnapshot,
  type DraftErrorAction,
  type SaveAftermath,
} from "@/ui/components/compose/compose-draft";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import type { PublishForm } from "@/ui/hooks/usePublishForm";
import type { ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";
import { TENANT_ID_PATTERN } from "@/ui/schemas/tenant-health.schema";
import { ApiError } from "@/ui/services/api-error";
import { ANONYMOUS_OWNER_KEY, composeDraftBuffer } from "@/ui/services/compose-draft-buffer";
import {
  beaconComposeDraft,
  discardComposeDraft,
  fetchComposeDraft,
  saveComposeDraft,
} from "@/ui/services/draft.api";

/**
 * E10 — the compose screen's anti-data-loss layer (docs/07 §4.1).
 *
 * The shape of the problem, and the answer to each half:
 *
 *  - WHAT is saved: only what the operator typed. `buildComposeDraftPayload`
 *    names every field it copies, so no composed content, stock, price or
 *    signed URL has a path into a draft (business rule 2).
 *  - WHERE it lives: the server row is the source of truth — it survives a new
 *    machine. `localStorage` is a buffer for the seconds between two PUTs. On
 *    mount both are read and the NEWER one wins.
 *  - WHEN it is written: local after ~400ms of quiet, server after ~1500ms, plus
 *    a flush on `pagehide` / hidden. Never on `beforeunload`: that one disables
 *    the bfcache and does not fire reliably when a mobile tab is discarded.
 *  - HOW it comes back: the input is re-filled and compose RE-RUNS for real, so
 *    the Sheet is read again and the stock gate runs again (business rule 3). A
 *    draft restores a question, never an answer.
 *
 * Storage is read in an effect, never during render: the server has no
 * `localStorage`, and reading it at render time is a hydration mismatch waiting
 * to happen (web-state-architecture rule 5).
 */

/** Local mirror: short enough to survive a closed tab, long enough not to churn. */
const LOCAL_DEBOUNCE_MS = 400;
/** Server autosave: one row write per pause, not one per keystroke. */
const SERVER_DEBOUNCE_MS = 1_500;

export type ComposeDraftPhase =
  /** Reading the two copies (and re-composing) on mount. */
  | "restoring"
  /** Nothing pending and nothing stored. */
  | "idle"
  /** A save is in flight. */
  | "saving"
  /** The server holds the current content. */
  | "saved"
  /** Stored on this machine only — no operator row on the server. */
  | "local-only"
  /** A "Xoá nháp" is on the wire. Not idle: the row is not gone yet. */
  | "discarding"
  /** The last save or delete failed; the local copy may still be good. */
  | "error";

export interface ComposeDraftState {
  phase: ComposeDraftPhase;
  /** ISO of the last successful SERVER save, or of the draft just restored. */
  updatedAt: string | null;
  /** Vietnamese reason, present for `phase === "error"`. */
  errorMessage: string | null;
  /**
   * WHICH operation failed. The status line and "Thử lại" both read it: a failed
   * DELETE retried with a PUT would write the row back instead of removing it.
   */
  errorAction: DraftErrorAction;
  /** What changed while restoring: cleared captions, dropped order, files. */
  notices: readonly string[];
  isRestoring: boolean;
  /** Saves again right now, after a failure. */
  retry: () => void;
  /** "Xoá nháp": drops both copies and resets the screen to an empty step 1. */
  discard: () => void;
  /** True when the buffer on this machine refuses to store (quota, private mode). */
  localBufferFailed: boolean;
}

export function useComposeDraft(wizard: ComposeWizard, publish: PublishForm): ComposeDraftState {
  const [phase, setPhase] = useState<ComposeDraftPhase>("restoring");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<DraftErrorAction>("save");
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [localBufferFailed, setLocalBufferFailed] = useState(false);
  /**
   * Flipped once the mount-time restore is over, whatever the outcome. It is
   * STATE, not just the ref below, because the autosave effect has to wake up
   * when it changes — a ref would leave autosave asleep until the next keystroke.
   */
  const [hydrationSettled, setHydrationSettled] = useState(false);

  /**
   * Latest wizard/publish instances. Both are rebuilt on every render, so a
   * callback that closed over the first one would keep calling into a screen
   * state that no longer exists — the classic stale-closure autosave bug.
   */
  const wizardRef = useRef(wizard);
  const publishRef = useRef(publish);
  useEffect(() => {
    wizardRef.current = wizard;
    publishRef.current = publish;
  });

  /** Content last handed to the server — the dirty check compares against it. */
  const lastSavedRef = useRef<ComposeDraftPayload | null>(null);
  /**
   * Generation that last stored something, counted directly rather than read off
   * `lastSavedRef`.
   *
   * `lastSavedRef !== null` used to stand in for "this generation has stored
   * something", and it only meant that because `discard()` happens to null the
   * ref 300 lines away. The publish path bumps the generation WITHOUT nulling
   * it, so on that path the stand-in was simply wrong — harmless today only
   * because of the order the two requests queue in. A counter says what it means.
   */
  const storedGenerationRef = useRef<number | null>(null);
  /** Freshest payload; the debounced callbacks read THIS, never a captured copy. */
  const latestPayloadRef = useRef<ComposeDraftPayload | null>(null);
  const localTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while a discard/publish is settling: autosave must not undo it. */
  const suspendedRef = useRef(false);
  /** True once something was stored, so EMPTYING the screen is saved too. */
  const everSavedRef = useRef(false);
  /**
   * The mount-time restore runs once — but "once" must mean "once it has
   * ACTUALLY applied", not "once it has started".
   *
   * React remounts every effect one extra time in development (Strict Mode).
   * With a single "already started" flag the first run claims the slot, its
   * cleanup cancels it mid-fetch, and the second run refuses because the ref
   * survived the remount — so the draft is read and then dropped on the floor,
   * which is exactly the F5-loses-everything bug this feature exists to prevent.
   * Two flags: the started one is HANDED BACK by the cleanup unless the run got
   * far enough to apply.
   */
  const hydrationStartedRef = useRef(false);
  const hydrationDoneRef = useRef(false);
  /**
   * Owner of the drafts on this screen, as named by the server. Held in a ref
   * because every storage call needs it and none of them re-render on it.
   * `null` = the server has not answered yet, and until it does the local buffer
   * must NOT be read: on a shared machine the entry sitting there may belong to
   * whoever used it last (business rule 7).
   */
  const ownerKeyRef = useRef<string | null>(null);
  /** Bumped by "Xoá nháp": answers from an older generation are ignored. */
  const generationRef = useRef(0);
  const saveAbortRef = useRef<AbortController | null>(null);
  /** The save currently on the wire, so a discard can wait for it to settle. */
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  /** The DELETE currently settling; a follow-up queues behind it, never races it. */
  const discardRequestRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const { form } = wizard;
  /**
   * Step 1 is uncontrolled (`register`), so typing a product code re-renders
   * nothing — and a draft that only notices the code when something ELSE
   * changes would miss exactly the case this feature exists for. Watching the
   * five step-1 fields costs one render per keystroke on a five-field step,
   * which is the cheapest honest way to autosave them.
   */
  const watched = useWatch({
    control: form.control,
    name: ["tenantId", "productCode", "color", "mediaKind", "videoTarget", "source"],
  });
  const values = form.getValues();
  const [watchedTenantId, productCode, color, mediaKind, videoTarget, source] = watched;

  const tenantId = (watchedTenantId ?? values.tenantId ?? "").trim();
  /**
   * The tenant field is editable, and half a UUID is not a tenant. Without this
   * every keystroke in that field would fire a request that can only 400, and
   * paint "Lưu nháp lỗi" over a form nobody has finished typing.
   */
  const canPersist = TENANT_ID_PATTERN.test(tenantId);

  const snapshot: ComposeDraftSnapshot = {
    step: wizard.step.slug,
    // The CAPTIONS' owner, not "what is composed": a draft can hold captions for
    // a product whose compose has since been refused, and the restore needs to
    // know which product they were written for.
    composeKey: wizard.captionsKey ?? "",
    productCode: productCode ?? "",
    color: color ?? "",
    mediaKind: mediaKind ?? values.mediaKind,
    videoTarget: videoTarget ?? values.videoTarget,
    source: source ?? values.source,
    captions: wizard.captionValues ?? {},
    captionOverrides: publish.captionOverrides,
    albumOrder: wizard.albumOrder,
    selectedChannelIds: publish.selectedIds,
    shareCaption: publish.shareCaption,
    schedule: { mode: publish.schedule.mode, value: publish.schedule.value },
  };

  const payload = buildComposeDraftPayload(snapshot);
  const contentKey = draftContentKey(payload);

  // Kept in a ref so the debounced callbacks always send the NEWEST payload,
  // not the one captured when the timer was armed. Written in an effect, never
  // during render, and declared FIRST so it is up to date before the autosave
  // effect below runs in the same commit.
  useEffect(() => {
    latestPayloadRef.current = payload;
  }, [payload]);

  const clearTimers = useCallback(() => {
    if (localTimerRef.current) clearTimeout(localTimerRef.current);
    if (serverTimerRef.current) clearTimeout(serverTimerRef.current);
    localTimerRef.current = null;
    serverTimerRef.current = null;
  }, []);

  /** Writes the buffer now, and reports a storage that refuses to hold it. */
  const mirrorLocally = useCallback(
    (next: ComposeDraftPayload) => {
      if (tenantId.length === 0) return;
      const result = composeDraftBuffer.write(
        { tenantId, ownerKey: ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY },
        next,
      );
      setLocalBufferFailed(!result.ok);
    },
    [tenantId],
  );

  /**
   * Deletes the draft row on the server — the single door every discard goes
   * through (operator, post-publish cleanup, and the second delete below).
   *
   * Two things it does that a bare `discardComposeDraft()` call cannot:
   *  - the pending-discard MARKER is written before the request and consumed
   *    only once the delete is confirmed. Between those two moments the row is
   *    "meant to be gone but may still be there", so a tab closed mid-way leaves
   *    the marker behind and the next mount retries the delete instead of
   *    offering the row back as "nháp đang soạn";
   *  - requests are queued, never parallel: a second delete that overtook the
   *    first would report success for a row the first one had not touched yet.
   *
   * `waitFor` is the save already on the wire: deleting before it settles would
   * let the two cross in the other order on purpose.
   */
  const requestServerDiscard = useCallback(
    (params: {
      reason: "operator" | "late-save" | "after-publish";
      waitFor?: Promise<void> | null;
      /** False for the post-publish path: the lô exists, the screen has moved on. */
      report: boolean;
    }) => {
      if (tenantId.length === 0) return;
      // The server has not named the operator yet on the very first seconds of a
      // mount, so the marker may land in the anonymous bucket. That is not a
      // guess about who this is — it is where the marker CAN be written — and
      // `hydrate` sweeps that bucket as well, so a marker written before the
      // owner was known is still found and retried.
      const ownerKey = ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY;
      composeDraftBuffer.markPendingDiscard({ tenantId, ownerKey });
      // The row is not gone until the server says so. Painting "Tự động lưu
      // nháp đang bật" over a delete still in flight tells the operator the
      // opposite of what is happening (core-feedback-states: the line must
      // describe the operation actually running).
      if (params.report && mountedRef.current) setPhase("discarding");

      const queued = Promise.allSettled([
        discardRequestRef.current ?? Promise.resolve(),
        params.waitFor ?? Promise.resolve(),
      ]);

      const request = queued
        .then(() => discardComposeDraft(tenantId))
        .then(() => {
          // Confirmed gone. The marker has done its job and must not survive to
          // make the next mount delete a draft typed after this one.
          composeDraftBuffer.takePendingDiscard({ tenantId, ownerKey });
          // Only OUR phase is handed back: a save that has since painted the
          // line owns it now, and stamping "idle" over it would erase a state
          // the operator is entitled to see.
          if (mountedRef.current) {
            setPhase((current) => (current === "discarding" ? "idle" : current));
          }
        })
        .catch((error: unknown) => {
          // The marker stays where it was written, so the next mount retries.
          // Never silent, whatever `report` says (CLAUDE.md rule 5).
          console.warn("[useComposeDraft] deleting the draft on the server failed", {
            scope: "ui/useComposeDraft",
            action: `discard:${params.reason}`,
            tenantId,
            errorCode: ApiError.is(error) ? error.code : undefined,
          });
          if (!params.report || !mountedRef.current) return;
          // The operator asked for this delete, so a failure is theirs to see —
          // named as a DELETE, so the line does not say "Lưu nháp lỗi" about a
          // deletion and "Thử lại" does not answer it with a save.
          setPhase("error");
          setErrorAction("discard");
          setErrorMessage(
            ApiError.is(error)
              ? error.userMessage
              : "Không xoá được nháp trên máy chủ. Hãy thử lại.",
          );
        });

      discardRequestRef.current = request;
      void request.then(() => {
        if (discardRequestRef.current === request) discardRequestRef.current = null;
      });
    },
    [tenantId],
  );

  /**
   * One server save. Never auto-retried: the next pause brings another one.
   *
   * Three guards on the WAY BACK, all about work the operator has since undone:
   *  - the request is abortable, and "Xoá nháp" aborts it, so the answer comes
   *    back fast and the screen is not left saying "đang lưu" after a delete;
   *  - the generation counter makes a late answer harmless on screen: it can no
   *    longer write `lastSavedRef` or paint "Đã lưu" over a reset screen;
   *  - and — the part an abort CANNOT do — a save that still answers 2xx from
   *    before the discard is treated as a resurrection of the row. Aborting only
   *    closes the socket on this side; a route handler that already had the
   *    request commits its upsert regardless, possibly after the DELETE. So the
   *    row is deleted a second time (`needsSecondDiscard`).
   */
  const pushToServer = useCallback(
    async (next: ComposeDraftPayload) => {
      if (tenantId.length === 0) return;

      const generation = generationRef.current;
      const controller = new AbortController();
      saveAbortRef.current = controller;
      setPhase("saving");
      /**
       * A delete already queued goes FIRST. `requestServerDiscard` makes a
       * delete wait for the save on the wire; without the mirror image of that
       * rule the pair is only ordered in one direction, and a PUT sent while a
       * DELETE was still queued could land behind it — deleting a draft the
       * operator had just typed. Ordering, not timing: no window to be lucky in.
       *
       * No cycle is possible: each request only ever waits on requests that were
       * registered before it.
       */
      const queuedDiscard = discardRequestRef.current;
      /**
       * What this save leaves behind. BOTH branches below write it through
       * `saveAftermath`, because the case that used to be missed — "Xoá nháp"
       * aborts the PUT, and an abort REJECTS — only ever lands in the catch.
       */
      let aftermath: SaveAftermath = {
        applyToScreen: false,
        reportError: false,
        resurrectedRow: false,
      };

      const attempt = (async () => {
        try {
          if (queuedDiscard) await Promise.allSettled([queuedDiscard]);
          const result = await saveComposeDraft({ tenantId, payload: next }, controller.signal);
          // The server answered "saved": the row EXISTS now, whatever this
          // screen did in the meantime. If the draft was discarded while this
          // request was out, that row is one nobody wants — see below.
          aftermath = saveAftermath({
            settlement: { outcome: "saved" },
            staleGeneration: generationRef.current !== generation,
          });
          if (!aftermath.applyToScreen || !mountedRef.current) return;
          lastSavedRef.current = next;
          storedGenerationRef.current = generation;
          everSavedRef.current = true;
          setErrorMessage(null);
          if (result.persisted) {
            setUpdatedAt(result.updatedAt);
            setPhase("saved");
          } else {
            // NOT a failure: this environment has no `app_user` row for the
            // session. The screen says "chỉ lưu trên máy này" rather than paint
            // a save that did not happen.
            setPhase("local-only");
          }
        } catch (error) {
          aftermath = saveAftermath({
            settlement: { outcome: "failed", aborted: controller.signal.aborted },
            staleGeneration: generationRef.current !== generation,
          });
          if (!aftermath.reportError || !mountedRef.current) return;
          setPhase("error");
          setErrorAction("save");
          setErrorMessage(
            ApiError.is(error)
              ? error.userMessage
              : "Không lưu được nháp lên máy chủ. Nháp vẫn được giữ trên máy này.",
          );
        } finally {
          if (saveAbortRef.current === controller) saveAbortRef.current = null;
        }
      })();

      inFlightSaveRef.current = attempt;
      await attempt;
      if (inFlightSaveRef.current === attempt) inFlightSaveRef.current = null;

      // The DELETE the operator asked for has already gone out (and, by the
      // queue in `requestServerDiscard`, this one waits for it). Firing it again
      // here is the only way the row that came back behind it goes away without
      // the operator having to discover it on their next visit.
      if (
        needsSecondDiscard({
          staleGeneration: aftermath.resurrectedRow,
          // Counted, not inferred: the publish path bumps the generation without
          // touching `lastSavedRef`, so reading that ref here answered the wrong
          // question on that path.
          storedSinceDiscard: storedGenerationRef.current === generationRef.current,
        })
      ) {
        requestServerDiscard({ reason: "late-save", report: true });
      }
    },
    [requestServerDiscard, tenantId],
  );

  // --- Hydrate on mount ------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    /** The restore is over (applied or not): release the URL, wake autosave. */
    function settle(nextPhase: ComposeDraftPhase): void {
      hydrationDoneRef.current = true;
      wizardRef.current.markRestoreSettled();
      setHydrationSettled(true);
      setPhase(nextPhase);
    }

    async function hydrate(): Promise<void> {
      // --- Edge cases first --------------------------------------------------
      // A run is already applying (or has applied) — leave it alone, and do NOT
      // touch the phase: overwriting it here is what turned a restored screen
      // back into an idle one.
      if (hydrationDoneRef.current || hydrationStartedRef.current) return;

      // Editing the tenant field changes where the draft is SAVED; it must not
      // pull another operator's draft onto a screen already being worked on.
      if (!canPersist) {
        settle("idle");
        return;
      }
      // A `?code=` deep link is an explicit "soạn bài NÀY"; restoring another
      // product on top of it would be a surprise, not a rescue.
      if (wizardRef.current.deepLinked) {
        settle("idle");
        return;
      }
      hydrationStartedRef.current = true;

      let server: ComposeDraftPayload | null = null;
      let serverUpdatedAt: string | null = null;
      let serverPersisted = true;
      /** Null until the server names the owner — see `ownerKeyRef`. */
      let ownerKey: string | null = null;
      let serverUnreachable = false;
      let unreachableMessage: string | null = null;

      // The SERVER answers first, because its answer says whose drafts these
      // are. Reading the buffer before that would mean reading a bucket we
      // cannot yet attribute to anybody.
      try {
        const response = await fetchComposeDraft(tenantId);
        server = response.draft;
        serverUpdatedAt = response.updatedAt;
        serverPersisted = response.persisted;
        ownerKey = response.ownerKey ?? ANONYMOUS_OWNER_KEY;
        ownerKeyRef.current = ownerKey;
      } catch (error) {
        serverUnreachable = true;
        // The server copy is unreachable. Staying silent would hide why only
        // half the work came back — but say it AFTER the cancelled guard below,
        // or the run React throws away leaves its message on a healthy screen.
        unreachableMessage = ApiError.is(error)
          ? error.userMessage
          : "Không đọc được nháp trên máy chủ.";
      }

      // Cancelled = this run is the one React threw away on the extra mount.
      // The cleanup has already handed the slot back, so the next run redoes it.
      if (cancelled) return;
      if (unreachableMessage !== null) setErrorMessage(unreachableMessage);

      // A draft left behind by a publish whose cleanup failed: drop it before it
      // can be offered back as "nháp đang soạn" of a post that already went out.
      //
      // BOTH buckets are swept. A discard that ran before the server had named
      // the operator wrote its marker under "anon" while this read looks under
      // the real key, and such a marker would never be found again — the row it
      // points at would come back as a restore. `takePendingDiscard` consumes,
      // so sweeping the second bucket cannot double-report anything.
      const pendingHere =
        ownerKey !== null && composeDraftBuffer.takePendingDiscard({ tenantId, ownerKey });
      const pendingAnonymous =
        ownerKey !== null &&
        ownerKey !== ANONYMOUS_OWNER_KEY &&
        composeDraftBuffer.takePendingDiscard({ tenantId, ownerKey: ANONYMOUS_OWNER_KEY });

      if (ownerKey !== null && (pendingHere || pendingAnonymous)) {
        server = null;
        serverUpdatedAt = null;
        void discardComposeDraft(tenantId).catch((error: unknown) => {
          composeDraftBuffer.markPendingDiscard({ tenantId, ownerKey });
          console.warn("[useComposeDraft] retry of the post-publish cleanup failed", {
            scope: "ui/useComposeDraft",
            action: "retry-discard",
            tenantId,
            errorCode: ApiError.is(error) ? error.code : undefined,
          });
        });
      }

      const local =
        ownerKey === null ? null : composeDraftBuffer.read({ tenantId, ownerKey });

      const picked = pickNewerDraft(server, local);
      if (!picked) {
        if (serverUnreachable) {
          // Honest about the gap: there IS possibly a buffered draft on this
          // machine, but with no owner from the server it cannot be attributed,
          // and opening someone else's draft is worse than opening none.
          setNotices([
            "Không đọc được nháp trên máy chủ nên chưa xác định được người dùng — bản lưu trên máy này không được mở ra để tránh nhầm nháp của người khác. Hãy tải lại trang khi có mạng.",
          ]);
        }
        settle(serverPersisted ? "idle" : "local-only");
        return;
      }

      // The operator got here first: they opened the screen, typed something,
      // and only now is the draft arriving. Overwriting live keystrokes with a
      // stored copy is the one thing worse than not restoring at all.
      const onScreen = latestPayloadRef.current;
      if (onScreen && isDraftWorthSaving(onScreen)) {
        setNotices([
          "Có nháp đã lưu, nhưng màn hình đã có nội dung bạn vừa nhập nên nháp cũ không được mở đè. Bấm “Xoá nháp” nếu muốn bỏ hẳn bản cũ.",
        ]);
        settle(serverPersisted ? "saved" : "local-only");
        return;
      }

      // Past this point the draft IS being applied, so the slot stays taken.
      hydrationDoneRef.current = true;
      // Re-fills the input and RE-COMPOSES (Sheet + stock gate run again).
      const outcome = await wizardRef.current.restoreDraft(picked.payload);

      // No early return on `cancelled` here, deliberately. The slot was taken
      // for good on the line above, so no later run will finish what this one
      // started: bailing out mid-restore left the form filled, the channels and
      // the schedule empty, and the screen stuck on "Đang khôi phục" with
      // "Xoá nháp" disabled — a half-restore nobody was told about.
      // The overrides come from the RESTORE OUTCOME, not straight out of the
      // payload: `restoreDraft` has already dropped the ones a draft had no
      // owner for, and it hands over the key the rest were typed under so the
      // publish form can refuse them if compose has since answered with another
      // product. Passing `picked.payload.captionOverrides` here unconditionally
      // is what let one product's per-channel text go out under another's.
      publishRef.current.restore({
        selectedChannelIds: picked.payload.selectedChannelIds,
        shareCaption: picked.payload.shareCaption,
        captionOverrides: outcome.captionOverrides,
        captionOverridesOwner: outcome.captionOverridesOwner,
        schedule: picked.payload.schedule,
      });

      // ONLY a server copy is content the server already holds. Marking a local
      // pick as "already sent" made the autosave guard treat the newer local
      // draft as saved, so it was never pushed and the next machine got the old
      // one — while this screen said "Đã lưu".
      if (picked.source === "server") lastSavedRef.current = picked.payload;
      everSavedRef.current = true;
      setNotices([
        picked.source === "local"
          ? "Đã khôi phục nháp lưu trên máy này (mới hơn bản trên máy chủ)."
          : "Đã khôi phục nháp đang lưu trên máy chủ.",
        ...outcome.notices,
      ]);
      setUpdatedAt(picked.source === "server" ? serverUpdatedAt : picked.payload.savedAt);
      settle(serverPersisted ? "saved" : "local-only");
    }

    // `settle` in the failure path too: an unexpected throw must not leave the
    // screen restoring forever with no way out.
    void hydrate().catch((error: unknown) => {
      console.error("[useComposeDraft] restoring the draft failed", {
        scope: "ui/useComposeDraft",
        action: "hydrate",
        tenantId,
        errorCode: ApiError.is(error) ? error.code : undefined,
      });
      setErrorMessage(
        ApiError.is(error) ? error.userMessage : "Không mở lại được nháp đã lưu.",
      );
      if (!hydrationDoneRef.current) hydrationStartedRef.current = false;
      settle("error");
    });

    return () => {
      cancelled = true;
      // A run that never got as far as applying must hand the slot back, or the
      // extra mount React does in development leaves nobody to restore anything.
      if (!hydrationDoneRef.current) hydrationStartedRef.current = false;
    };
  }, [tenantId, canPersist]);

  // --- Autosave --------------------------------------------------------------
  /**
   * `contentKey` is the dependency, so the debounce restarts on a real edit and
   * not on every re-render. Everything else the guard needs lives in refs and is
   * read HERE rather than during render — a ref read at render time is exactly
   * the value React tells you not to trust.
   */
  useEffect(() => {
    // `phase` is deliberately NOT a dependency: `pushToServer` sets it to
    // "saving" as its first act, so depending on it re-ran this effect mid-save
    // and armed a second timer — one PUT of identical content per round trip
    // longer than the debounce. Hydration state is read from its ref instead.
    if (!hydrationDoneRef.current || suspendedRef.current || !canPersist) return;

    const next = latestPayloadRef.current;
    if (!next) return;

    const savedKey = lastSavedRef.current ? draftContentKey(lastSavedRef.current) : null;
    if (savedKey === contentKey) return;
    // An untouched screen must not create a row; once anything HAS been stored,
    // emptying it is a change worth saving too.
    if (!isDraftWorthSaving(next) && !everSavedRef.current) return;

    localTimerRef.current = setTimeout(() => {
      const latest = latestPayloadRef.current;
      if (latest) mirrorLocally(latest);
    }, LOCAL_DEBOUNCE_MS);

    serverTimerRef.current = setTimeout(() => {
      const latest = latestPayloadRef.current;
      if (latest) void pushToServer(latest);
    }, SERVER_DEBOUNCE_MS);

    return () => {
      if (localTimerRef.current) clearTimeout(localTimerRef.current);
      if (serverTimerRef.current) clearTimeout(serverTimerRef.current);
    };
    // `phase` intentionally absent (see above); `hydrationSettled` is what tells
    // this effect the restore is over, without re-running it on every save.
  }, [contentKey, hydrationSettled, canPersist, mirrorLocally, pushToServer]);

  // --- Flush while the tab is going away -------------------------------------
  useEffect(() => {
    function flush(): void {
      if (suspendedRef.current || !canPersist) return;
      const next = latestPayloadRef.current;
      if (!next || !isDraftWorthSaving(next)) return;
      const savedKey = lastSavedRef.current ? draftContentKey(lastSavedRef.current) : null;
      if (savedKey === draftContentKey(next)) return;

      clearTimers();
      // Local first: it is synchronous and nothing can cancel it.
      mirrorLocally(next);
      if (beaconComposeDraft({ tenantId, payload: next })) lastSavedRef.current = next;
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") flush();
    }

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [canPersist, clearTimers, mirrorLocally, tenantId]);

  /**
   * The draft's job is done once the batch exists.
   *
   * The effect only touches the OUTSIDE world (timers, buffer, server); what the
   * screen shows is derived from `batchCreated` in the return value below. An
   * effect that also called setState here would be a cascading render for a
   * state React can compute on its own.
   */
  const batchCreated = publish.createBatch.isSuccess;
  useEffect(() => {
    if (!batchCreated || tenantId.length === 0) return;
    const ownerKey = ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY;

    suspendedRef.current = true;
    generationRef.current += 1;
    saveAbortRef.current?.abort();
    clearTimers();
    composeDraftBuffer.clear({ tenantId, ownerKey });

    // The lô exists, so a failed cleanup is not the operator's failure to see —
    // but it is NOT nothing either: the row left behind would be offered back as
    // "nháp đang soạn" of a post that has already gone out. `report: false` keeps
    // it off this screen; the marker and the log keep it from vanishing.
    requestServerDiscard({
      reason: "after-publish",
      waitFor: inFlightSaveRef.current,
      report: false,
    });
  }, [batchCreated, clearTimers, requestServerDiscard, tenantId]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (localTimerRef.current) clearTimeout(localTimerRef.current);
      if (serverTimerRef.current) clearTimeout(serverTimerRef.current);
    };
  }, []);

  /**
   * "Thử lại" repeats THE OPERATION THAT FAILED.
   *
   * It used to always save. After a failed "Xoá nháp" that meant the button
   * under "không xoá được nháp" wrote a row back to the server — the exact
   * opposite of what it says, and on an already-emptied screen it wrote an empty
   * draft. `draftRetryAction` is the mapping, kept pure so it is testable.
   */
  const retry = useCallback(() => {
    const action = draftRetryAction({ phase, errorAction });
    if (action === "none") return;

    if (action === "discard") {
      // No phase written here: `requestServerDiscard` sets "discarding" and
      // hands it back to "idle" only once the server has confirmed the row is
      // gone. Claiming "idle" up front is the same lie the status line just
      // stopped telling.
      setErrorMessage(null);
      requestServerDiscard({
        reason: "operator",
        waitFor: inFlightSaveRef.current,
        report: true,
      });
      return;
    }

    const next = latestPayloadRef.current;
    if (!next) return;
    suspendedRef.current = false;
    mirrorLocally(next);
    void pushToServer(next);
  }, [errorAction, mirrorLocally, phase, pushToServer, requestServerDiscard]);

  const discard = useCallback(() => {
    suspendedRef.current = true;
    clearTimers();
    // Everything already on the wire belongs to the draft being thrown away.
    // The generation bump is what makes a late answer harmless HERE; the abort
    // only gets that answer back quickly. Neither can stop a handler the server
    // has already started, which is why `pushToServer` watches for a save that
    // still succeeds afterwards and deletes the row again.
    generationRef.current += 1;
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;

    lastSavedRef.current = null;
    everSavedRef.current = false;
    setNotices([]);
    setErrorMessage(null);
    setUpdatedAt(null);
    setPhase("idle");

    if (tenantId.length > 0) {
      const ownerKey = ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY;
      composeDraftBuffer.clear({ tenantId, ownerKey });

      // Waits for the aborted save to settle before deleting, so the two
      // requests cannot cross on the wire in the other order. Should that save
      // still answer "đã lưu" afterwards, `pushToServer` sends this DELETE a
      // second time — the abort alone does not stop a handler already running.
      requestServerDiscard({
        reason: "operator",
        waitFor: inFlightSaveRef.current,
        report: true,
      });
    }

    // The screen goes back to an empty step 1: dropping the stored copy while
    // leaving the content on screen would simply save it again a second later.
    wizardRef.current.resetWizard();
    publishRef.current.reset();
    suspendedRef.current = false;
  }, [clearTimers, requestServerDiscard, tenantId]);

  return useMemo(
    () => ({
      // Once the batch is created the draft is gone by definition — derived, so
      // no effect has to write it.
      phase: batchCreated ? "idle" : phase,
      updatedAt: batchCreated ? null : updatedAt,
      errorMessage: batchCreated ? null : errorMessage,
      errorAction,
      notices: batchCreated ? [] : notices,
      isRestoring: !batchCreated && (phase === "restoring" || wizard.restorePhase === "restoring"),
      retry,
      discard,
      localBufferFailed,
    }),
    [
      batchCreated,
      discard,
      errorAction,
      errorMessage,
      localBufferFailed,
      notices,
      phase,
      retry,
      updatedAt,
      wizard.restorePhase,
    ],
  );
}
