"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  COMPOSE_CHANNELS,
  ComposeWizardSchema,
  STEP_PRODUCT_FIELDS,
  type CaptionsResponse,
  type ComposeResponse,
  type ComposeWizardValues,
  type UploadRejection,
  type UploadResponse,
} from "@/ui/schemas/compose.schema";
import {
  applyAlbumOrder,
  captionsOwnerAfterCompose,
  droppedOverridesNotice,
  restorableDraftCaptions,
  restoreTargetStep,
  shouldClearCaptions,
} from "@/ui/components/compose/compose-draft";
import type { QueuedFile } from "@/ui/components/compose/upload-queue";
import type { ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";
import { ApiError } from "@/ui/services/api-error";
import { composePost, generateCaptions, uploadMedia } from "@/ui/services/post.api";

/**
 * Logic layer of the compose wizard (docs/07 §4.1 + core-wizard).
 *
 * Decisions worth knowing before reading the code:
 *  - ONE form object and ONE schema for the whole flow; each step validates its
 *    own fields only, and step 3 re-checks everything before the final action.
 *  - The step lives in the URL (`?step=`), so browser Back walks one step back
 *    instead of leaving the flow, and F5 does not jump to a random step.
 *  - The composed result is NOT in the URL (web-wizard rule 4: never put data in
 *    a query string). A reload therefore loses it — and E10's draft is what
 *    brings it back: `restoreDraft()` re-fills the INPUT and re-runs compose for
 *    real (Sheet lookup + stock gate), so a restored screen is never a replay of
 *    yesterday's answer. Where that fails, the operator stays on step 1 with the
 *    server's own reason instead of a half-empty step 2.
 */

export const COMPOSE_STEPS = [
  { slug: "san-pham", index: 1, title: "Chọn sản phẩm" },
  { slug: "caption", index: 2, title: "Duyệt caption" },
  { slug: "xem-lai", index: 3, title: "Xem lại" },
] as const;

export type ComposeStepSlug = (typeof COMPOSE_STEPS)[number]["slug"];

/** "idle" = nothing to restore (yet); "done" covers success AND refusal. */
export type ComposeRestorePhase = "idle" | "restoring" | "done";

/** What the step-1 action did: composed, refused by validation, or failed. */
export type ProductStepOutcome =
  | { ok: true; composed: ComposeResponse }
  | { ok: false; reason: "invalid" | "failed" };

export interface ComposeRestoreOutcome {
  /** True only when the post was re-composed for real (Sheet + stock gate). */
  readonly composed: boolean;
  /** What changed on the way back: cleared captions, dropped order, files. */
  readonly notices: readonly string[];
  /**
   * Per-channel overrides the draft may hand to the publish form, and the key
   * they were typed under. The caller passes BOTH: the wizard has re-composed by
   * the time it restores them, so the publish form is the one that can still say
   * "that is another product's text" and drop them.
   */
  readonly captionOverrides: Record<string, string>;
  readonly captionOverridesOwner: string | null;
}

const FIRST_STEP = COMPOSE_STEPS[0];

function stepFromSlug(value: string | null): (typeof COMPOSE_STEPS)[number] {
  return COMPOSE_STEPS.find((step) => step.slug === value) ?? FIRST_STEP;
}

/**
 * Identity of what was composed — changing it invalidates the captions.
 * The media kind is part of it: a caption written for an album is not the same
 * post as a caption for a Reel, and letting it survive silently would be the
 * "im lặng xoá / im lặng giữ" mistake core-wizard forbids.
 */
function composeKey(
  values: Pick<ComposeWizardValues, "productCode" | "color" | "mediaKind" | "videoTarget">,
): string {
  const target = values.mediaKind === "video" ? values.videoTarget : "-";
  return [
    values.productCode.trim().toUpperCase(),
    (values.color ?? "").trim().toLowerCase(),
    values.mediaKind,
    target,
  ].join("|");
}

function emptyCaptions(): Record<string, string> {
  return Object.fromEntries(COMPOSE_CHANNELS.map((channel) => [channel.id, ""]));
}

export function useComposeWizard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const form = useForm<ComposeWizardValues>({
    resolver: zodResolver(ComposeWizardSchema),
    mode: "onSubmit",
    defaultValues: {
      tenantId: DEMO_TENANT_ID,
      productCode: "",
      color: "",
      // Ảnh is the default: Phase 1 is an album tool, video is opt-in.
      mediaKind: "image",
      videoTarget: "facebook_video",
      // Drive is the default mode; mode B is the exception (brief §8).
      source: "drive",
      captions: emptyCaptions(),
    },
  });

  const [composed, setComposed] = useState<ComposeResponse | null>(null);
  /**
   * The album in PUBLISH order, which the operator may rearrange (brief §8 —
   * both file modes end with an ordered album whose first entry is the cover).
   *
   * Held here rather than written back into `composed`: the compose response is
   * the server's answer and must stay comparable to what was returned, while
   * the arrangement belongs to this post only. Nothing is written to
   * `media_asset` — that table belongs to the Drive sync.
   */
  const [album, setAlbum] = useState<readonly ComposeResponse["media"][number][]>([]);
  /**
   * Identity of the post composed RIGHT NOW — null before the first lookup and
   * after a refused one, because at that moment nothing is composed.
   */
  const composedKeyRef = useRef<string | null>(null);
  /**
   * Identity the CAPTIONS in the form were written for. A different question
   * from the ref above, and the one that keeps the operator safe: a refused
   * compose empties steps 2 and 3 but leaves the caption fields exactly as they
   * were, so this must survive it (`captionsOwnerAfterCompose`).
   */
  const captionsOwnerRef = useRef<string | null>(null);
  /** Render-visible copy of `captionsOwnerRef` — the draft is stamped with it. */
  const [captionsKey, setCaptionsKey] = useState<string | null>(null);
  /**
   * True when this mount started on a step past the first one — i.e. a reload
   * or a shared link, with no composed post in memory to back it. Computed once
   * in the initialiser: nothing is composed at mount time, so the check cannot
   * be wrong, and no effect has to write state for it.
   */
  const [arrivedPastFirstStep, setArrivedPastFirstStep] = useState(
    () => searchParams.get("step") !== null,
  );
  /**
   * Where the draft restore has got to.
   *
   * It starts at "restoring" when the URL already claims an inner step, because
   * that is exactly the reload a draft is meant to survive: the effect below
   * would otherwise strip `?step=` within the first frame — long before the
   * draft has been read — and the operator would watch the screen fall back to
   * an empty step 1 while the restore was still in flight.
   * `markRestoreSettled()` is how the draft hook says "nothing is coming".
   */
  const [restorePhase, setRestorePhase] = useState<ComposeRestorePhase>(() =>
    searchParams.get("step") !== null ? "restoring" : "idle",
  );
  /** Set when re-composing another code cleared captions typed for the old one. */
  const [captionsCleared, setCaptionsCleared] = useState(false);

  const requestedStep = stepFromSlug(searchParams.get("step"));
  // A step beyond 1 is only valid once there is something composed; otherwise
  // the operator would review a post that does not exist.
  const step = composed ? requestedStep : FIRST_STEP;

  // Sync the URL with reality — the only thing this effect does is navigate.
  // `replace`: an unreachable step must not stay in history for Back to find.
  // It WAITS for the restore: a step is only unreachable once we know no draft
  // is going to bring it back.
  useEffect(() => {
    if (composed || requestedStep.index === FIRST_STEP.index) return;
    if (restorePhase === "restoring") return;
    router.replace(pathname, { scroll: false });
  }, [composed, requestedStep.index, restorePhase, router, pathname]);

  const goToStep = useCallback(
    (slug: ComposeStepSlug) => {
      setArrivedPastFirstStep(false);
      const params = new URLSearchParams(searchParams.toString());
      if (slug === FIRST_STEP.slug) params.delete("step");
      else params.set("step", slug);
      const query = params.toString();
      // `push`, not replace: Back inside the wizard must go one step back.
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // --- E9 mode B ------------------------------------------------------------
  // The queue holds files chosen but not yet sent. It is NOT form state: a File
  // is not serialisable, and react-hook-form would try to clone it.
  const [uploadQueue, setUploadQueue] = useState<QueuedFile[]>([]);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadRejections, setUploadRejections] = useState<UploadRejection[]>([]);

  const upload = useMutation<UploadResponse, ApiError, void>({
    mutationFn: () => {
      const values = form.getValues();
      return uploadMedia({
        tenantId: values.tenantId,
        productCode: values.productCode,
        files: uploadQueue.map((item) => item.file),
        // The queue order IS the album order; index 0 is the cover.
        order: uploadQueue.map((_item, index) => index),
      });
    },
    retry: false,
    onSuccess: (result) => {
      setUploadedCount(result.accepted.length);
      setUploadRejections(result.rejected);
      // Accepted files are stored server-side now; keeping them queued would
      // let a second click upload the same album twice.
      setUploadQueue([]);
    },
    onError: () => setUploadRejections([]),
  });

  /**
   * Records who the captions on screen belong to, in both places at once: the
   * ref every decision reads, and the state the draft is stamped with. Two
   * writers for one fact is how they drift, so there is exactly one setter.
   */
  const setCaptionsOwner = useCallback((next: string | null) => {
    captionsOwnerRef.current = next;
    setCaptionsKey(next);
  }, []);

  /**
   * The only way to REPLACE the caption fields wholesale. Text and owner move in
   * one statement, so there is no reachable state in which a replacement leaves
   * the fields holding text while the owner says `null`.
   *
   * Per-channel writes are a separate case and stay legal: `captions.onSuccess`
   * below and the operator typing in `StepCaption`. Both can only happen once
   * `composed` exists, and `composed` exists only after `compose.onSuccess` has
   * stamped an owner — they write INSIDE an ownership that is already settled
   * rather than establishing one. `resetWizard` also clears the field through
   * `form.reset`, immediately followed by `applyCaptions({}, null)`; keep those
   * two adjacent, with no early return between them.
   *
   * This is not style. `restoreDraft` used to write the fields near the top and
   * stamp the owner forty lines further down, and an early return between the
   * two (a draft saved with the product code cleared) walked straight past the
   * stamp: mã A's caption sat in the form owned by nobody, `shouldClearCaptions`
   * had nothing to compare against, and the next code looked up inherited it.
   * The pairing is what makes a future early return unable to make that mistake
   * again — there is nothing left to forget.
   *
   * Owner-only moves are still legal (`setCaptionsOwner`): a compose that keeps
   * the text on screen changes who it belongs to without touching a character.
   * What is illegal is the other direction — writing text without saying whose.
   */
  const applyCaptions = useCallback(
    (next: Record<string, string>, ownerKey: string | null) => {
      form.setValue("captions", { ...emptyCaptions(), ...next }, { shouldDirty: false });
      captionsOwnerRef.current = ownerKey;
      setCaptionsKey(ownerKey);
    },
    [form],
  );

  const compose = useMutation<ComposeResponse, ApiError, void>({
    mutationFn: () => {
      const values = form.getValues();
      return composePost({
        tenantId: values.tenantId,
        productCode: values.productCode,
        color: values.color,
        mediaKind: values.mediaKind,
        videoTarget: values.videoTarget,
        source: values.source,
      });
    },
    retry: false,
    onSuccess: (result) => {
      const nextKey = composeKey(form.getValues());
      const hadCaptions = Object.values(form.getValues().captions ?? {}).some(
        (text) => text.trim().length > 0,
      );
      // Whatever is in the caption fields once this is over — cleared, kept, or
      // still empty — belongs to this post.
      const nextOwner = captionsOwnerAfterCompose(captionsOwnerRef.current, {
        ok: true,
        key: nextKey,
      });
      // A caption written for another code must never survive into this post.
      // The rule itself lives in `shouldClearCaptions` so a manual re-lookup and
      // a draft restore cannot drift apart — and so it is testable on its own.
      if (shouldClearCaptions(captionsOwnerRef.current, nextKey, hadCaptions)) {
        // Emptied AND re-owned in one call: never one without the other.
        applyCaptions({}, nextOwner);
        setCaptionsCleared(true);
      } else {
        // The text is untouched, only its owner moves — the legal direction.
        setCaptionsOwner(nextOwner);
        setCaptionsCleared(false);
      }
      composedKeyRef.current = nextKey;
      setComposed(result);
      // A new album means a new arrangement. Keeping the old ids would either
      // drop photos the operator can now see or resurrect ones that are gone.
      // A restored draft re-applies its own order AFTER this, by asset id.
      setAlbum(result.media);
      setArrivedPastFirstStep(false);
    },
    onError: () => {
      // Blocked/failed compose invalidates the current POST: step 2 and 3 must
      // not stay reachable with stale data from the previous product.
      setComposed(null);
      setAlbum([]);
      composedKeyRef.current = null;
      // The CAPTIONS are a separate matter and they are still in the form, so
      // they still belong to whoever they were written for. Forgetting it here
      // is what let a caption survive under the NEXT code looked up: with no
      // owner left, `shouldClearCaptions` had nothing to compare against.
      setCaptionsOwner(captionsOwnerAfterCompose(captionsOwnerRef.current, { ok: false }));
    },
  });

  const captions = useMutation<CaptionsResponse, ApiError, void>({
    mutationFn: () => {
      if (!composed) {
        throw new ApiError({
          code: "INVALID_INPUT",
          status: 0,
          message: "generateCaptions called before compose",
          userMessage: "Chưa có dữ liệu bài đăng. Hãy quay lại bước 1 và tra mã sản phẩm.",
        });
      }
      return generateCaptions({
        tenantId: composed.tenantId,
        content: composed.content,
        channels: COMPOSE_CHANNELS.map((channel) => channel.id),
      });
    },
    retry: false,
    onSuccess: (result) => {
      // The one caption write that does NOT carry an owner with it, and the only
      // one that may not: `mutationFn` above refuses to run without a composed
      // post, and a composed post means `compose.onSuccess` has already stamped
      // the owner. This text is written INTO that ownership, it does not change
      // it. Any other whole-field write must go through `applyCaptions`.
      for (const item of result.generated) {
        form.setValue(`captions.${item.channelId}`, item.text, { shouldDirty: true });
      }
    },
  });

  /**
   * Validates ONLY the fields of step 1 (core-wizard: never validate a step the
   * operator has not reached), then composes. On failure the focus moves to the
   * first invalid field so a keyboard user is not left guessing.
   */
  const submitProductStep = useCallback(async (): Promise<ProductStepOutcome> => {
    const valid = await form.trigger([...STEP_PRODUCT_FIELDS]);
    if (!valid) {
      const firstInvalid = STEP_PRODUCT_FIELDS.find((field) => form.getFieldState(field).invalid);
      if (firstInvalid) form.setFocus(firstInvalid);
      return { ok: false, reason: "invalid" };
    }
    try {
      // `mutateAsync`, so the caller can await the answer. The mutation's own
      // `onError` still runs; the throw is caught here rather than left to
      // become an unhandled rejection.
      return { ok: true, composed: await compose.mutateAsync() };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }, [compose, form]);

  /**
   * E10 — puts a stored draft back on screen.
   *
   * The order below is the whole point, and it is the order a human would use:
   *  1. re-fill the INPUT fields (nothing else is stored, by design);
   *  2. re-run compose FOR REAL — the Sheet is read again and the stock gate
   *     runs again (business rule 3). A draft never resurrects an answer;
   *  3. only then decide which step to show, and say what changed on the way.
   *
   * Compose refusing (hết hàng, không có ảnh, mã đã đổi) is a normal outcome,
   * not a restore failure: the typed input stays on screen, the operator reads
   * the server's own sentence under step 1, and nothing pretends to be composed.
   */
  const restoreDraft = useCallback(
    async (draft: ComposeDraftPayload): Promise<ComposeRestoreOutcome> => {
      setRestorePhase("restoring");
      const notices: string[] = [];

      // Decided BEFORE anything is written to the form: a draft whose captions
      // record no owner (`composeKey: ""` — what the build with the leak wrote,
      // and those rows are in the DB today) has its captions dropped here, so
      // there is no moment at which unowned text sits in the fields.
      const restorable = restorableDraftCaptions(draft);

      /**
       * EVERY exit goes through here, so everything that must be true of a
       * finished restore is stated once:
       *  - the overrides that lost their product are announced, not dropped in
       *    silence (business rule 5). The publish form prunes them on the next
       *    render; without this line the operator would simply find the boxes
       *    back on the shared caption with no explanation.
       */
      const finish = (composedOk: boolean): ComposeRestoreOutcome => {
        const droppedOverrides = droppedOverridesNotice({
          overrides: restorable.captionOverrides,
          draftOwnerKey: restorable.ownerKey,
          currentKey: captionsOwnerRef.current,
        });
        if (droppedOverrides !== null) notices.push(droppedOverrides);

        setRestorePhase("done");
        return {
          composed: composedOk,
          notices,
          captionOverrides: restorable.captionOverrides,
          // The DRAFT's key, not the one just composed: the publish form
          // compares it against what is on screen now, and that comparison is
          // the whole point.
          captionOverridesOwner: restorable.ownerKey,
        };
      };

      form.setValue("productCode", draft.productCode, { shouldDirty: false });
      form.setValue("color", draft.color, { shouldDirty: false });
      form.setValue("mediaKind", draft.mediaKind, { shouldDirty: false });
      form.setValue("videoTarget", draft.videoTarget, { shouldDirty: false });
      form.setValue("source", draft.source, { shouldDirty: false });
      // Text AND owner, one statement, BEFORE the first early return below.
      // `restorable.ownerKey` is null exactly when the captions were dropped for
      // having none, so "fields full, owner null" is not a state this function
      // can produce any more — whatever exit it takes.
      applyCaptions(restorable.captions, restorable.ownerKey);
      if (restorable.notice !== null) notices.push(restorable.notice);

      // A File cannot be serialised, so mode B's queue is the one thing a draft
      // provably cannot carry. Said plainly, because silently landing on an
      // upload post with no files is a trap.
      if (draft.source === "upload") {
        notices.push(
          "Chế độ tự tải lên: file bạn đã chọn KHÔNG được lưu trong nháp. Hãy chọn và tải lên lại trước khi soạn tiếp.",
        );
      }

      // Nothing to look up yet — the draft was saved on a half-typed step 1.
      if (draft.productCode.trim().length === 0) return finish(false);

      // The owner was stamped together with the text above. It is deliberately
      // NOT re-stamped here: a second write is a second thing to keep in step,
      // and the compose below reads the ref to decide whether to clear.
      const draftHadCaptions = Object.values(restorable.captions).some(
        (text) => text.trim().length > 0,
      );

      // Through `submitProductStep`, NOT straight to the mutation: a restore
      // must pass the same field validation and land focus in the same place a
      // typed lookup does. A draft written by an older build can carry a code
      // this build refuses, and that has to be visible, not swallowed.
      const outcome = await submitProductStep();
      if (!outcome.ok) {
        notices.push(
          outcome.reason === "invalid"
            ? "Nháp cũ có mã sản phẩm không còn hợp lệ. Hãy sửa lại ở bước 1 rồi tra lại."
            : "Không mở lại được bài đang soạn — lý do ở ngay bên dưới. Nội dung bạn đã gõ vẫn còn, hãy sửa rồi tra lại.",
        );
        // Compose refused (hết hàng, thiếu ảnh…): step 1 is the only honest
        // place to be, and `compose.error` under it carries the real sentence.
        const blockedTarget = restoreTargetStep({
          composed: false,
          draftStep: draft.step,
          everyCaption: false,
        });
        if (blockedTarget !== requestedStep.slug) goToStep(blockedTarget);
        return finish(false);
      }

      if (
        shouldClearCaptions(restorable.ownerKey, composeKey(form.getValues()), draftHadCaptions)
      ) {
        notices.push(
          "Mã hoặc màu đã khác so với lúc lưu nháp nên caption cũ đã bị xoá — caption luôn gắn với đúng sản phẩm của nó.",
        );
      }

      const arranged = applyAlbumOrder(outcome.composed.media, draft.albumOrder);
      if (arranged.album) setAlbum(arranged.album);
      if (arranged.notice) notices.push(arranged.notice);

      // Step 3 is only reachable with a caption for every channel; a restore
      // must respect that gate, not walk around it.
      const restoredCaptions = form.getValues().captions ?? {};
      const target = restoreTargetStep({
        composed: true,
        draftStep: draft.step,
        everyCaption: COMPOSE_CHANNELS.every(
          (channel) => (restoredCaptions[channel.id] ?? "").trim().length > 0,
        ),
      });
      // After a reload the URL usually already says the right step; navigating
      // to it again would push a duplicate history entry for a move nobody made.
      // The comparison also covers the reverse: a URL claiming step 2 while the
      // draft says step 1 must be corrected, not left showing the wrong screen.
      if (target !== requestedStep.slug) goToStep(target);

      return finish(true);
    },
    [applyCaptions, form, goToStep, requestedStep.slug, submitProductStep],
  );

  /** Called by the draft hook when no restore is coming (or none was possible). */
  const markRestoreSettled = useCallback(() => {
    setRestorePhase((current) => (current === "restoring" ? "done" : current));
  }, []);

  /**
   * "Xoá nháp" — back to an empty screen, in one action.
   *
   * Clearing the stored copy alone would be a lie: autosave would put the very
   * same content back a second later. Discarding a draft means starting over
   * (core-wizard: always offer "bỏ để làm lại"), so the wizard itself resets.
   */
  const resetWizard = useCallback(() => {
    const { tenantId } = form.getValues();
    form.reset({
      tenantId,
      productCode: "",
      color: "",
      mediaKind: "image",
      videoTarget: "facebook_video",
      source: "drive",
      captions: emptyCaptions(),
    });
    setComposed(null);
    setAlbum([]);
    composedKeyRef.current = null;
    // `form.reset` above already blanked the caption fields; this re-states them
    // together with the owner so the pairing holds on every path that empties
    // them. Nothing on screen belongs to anything any more.
    applyCaptions({}, null);
    setCaptionsCleared(false);
    setRestorePhase("done");
    setUploadQueue([]);
    setUploadedCount(0);
    setUploadRejections([]);
    compose.reset();
    captions.reset();
    upload.reset();
    goToStep(FIRST_STEP.slug);
  }, [applyCaptions, captions, compose, form, goToStep, upload]);

  /**
   * Deep link from the product list: `/compose?code=MGKVX6310&color=TRẮNG`
   * prefills step 1 and looks the code up straight away, so "Soạn bài" on a row
   * lands on the composed post instead of a form the operator must re-submit.
   *
   * Guards (an auto-submitting effect is a loop waiting to happen):
   *  - it runs ONCE per code — the ref is written BEFORE the request, so a
   *    blocked/failed compose does not retry itself forever;
   *  - it never fires on top of an existing composed post, so re-rendering on
   *    step 2 cannot silently recompose;
   *  - it is a shortcut, not a bypass: the same validation and the same stock
   *    gate run as if the operator had typed the code and pressed the button.
   */
  const codeParam = searchParams.get("code");
  const colorParam = searchParams.get("color");
  const prefilledCodeRef = useRef<string | null>(null);

  useEffect(() => {
    const code = (codeParam ?? "").trim();
    if (code.length === 0 || prefilledCodeRef.current === code) return;

    prefilledCodeRef.current = code;
    form.setValue("productCode", code.toUpperCase(), { shouldDirty: false });
    form.setValue("color", (colorParam ?? "").trim(), { shouldDirty: false });

    // Nothing composed yet = the operator just arrived. Otherwise leave the
    // screen alone: they are already working on something.
    if (composedKeyRef.current === null) void submitProductStep();
    // `submitProductStep` is intentionally out of the dependency list: it is
    // recreated on every mutation state change, and the ref above is what makes
    // this effect run once per code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam, colorParam, form]);

  // `useWatch`, not `form.watch()`: the latter returns a fresh function on every
  // render, which the React Compiler cannot memoise safely.
  const captionValues = useWatch({ control: form.control, name: "captions" });

  return {
    form,
    captionValues,
    step,
    steps: COMPOSE_STEPS,
    goToStep,
    composed,
    /** The album in publish order — use this, never `composed.media`. */
    album,
    setAlbum,
    /** Publish order as ids — what a draft stores, and all it stores. */
    albumOrder: album.map((asset) => asset.driveFileId),
    compose,
    captions,
    submitProductStep,
    /**
     * Identity the captions on screen were written for; null when none belong
     * to anything yet. This — not "what is composed" — is what a draft stores,
     * because a draft can hold captions whose compose has since been refused.
     */
    captionsKey,
    restoreDraft,
    markRestoreSettled,
    restorePhase,
    resetWizard,
    /**
     * A `?code=` deep link is an explicit "soạn bài này", so it outranks a
     * stored draft — the draft hook skips restoring when this is true.
     */
    deepLinked: (searchParams.get("code") ?? "").trim().length > 0,
    /**
     * True while the operator is looking at step 1 after landing on an inner
     * step with nothing composed — a reload, or a shared link, that the draft
     * could not (or was not asked to) bring back.
     */
    rewound: arrivedPastFirstStep && !composed && restorePhase !== "restoring",
    captionsCleared,
    upload,
    uploadQueue,
    setUploadQueue,
    uploadedCount,
    uploadRejections,
    /** True once every channel has a non-empty caption (step 3 gate). */
    hasEveryCaption: COMPOSE_CHANNELS.every(
      (channel) => (captionValues?.[channel.id] ?? "").trim().length > 0,
    ),
  };
}

export type ComposeWizard = ReturnType<typeof useComposeWizard>;
