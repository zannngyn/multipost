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
} from "@/ui/schemas/compose.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";
import { ApiError } from "@/ui/services/api-error";
import { composePost, generateCaptions } from "@/ui/services/post.api";

/**
 * Logic layer of the compose wizard (docs/07 §4.1 + core-wizard).
 *
 * Decisions worth knowing before reading the code:
 *  - ONE form object and ONE schema for the whole flow; each step validates its
 *    own fields only, and step 3 re-checks everything before the final action.
 *  - The step lives in the URL (`?step=`), so browser Back walks one step back
 *    instead of leaving the flow, and F5 does not jump to a random step.
 *  - The composed result is NOT in the URL (web-wizard rule 4: never put data in
 *    a query string). A reload therefore loses it — the hook detects that and
 *    sends the operator back to step 1 with an explicit notice rather than
 *    showing a half-empty step 2. Server-side drafts are a later epic.
 */

export const COMPOSE_STEPS = [
  { slug: "san-pham", index: 1, title: "Chọn sản phẩm" },
  { slug: "caption", index: 2, title: "Duyệt caption" },
  { slug: "xem-lai", index: 3, title: "Xem lại" },
] as const;

export type ComposeStepSlug = (typeof COMPOSE_STEPS)[number]["slug"];

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
      captions: emptyCaptions(),
    },
  });

  const [composed, setComposed] = useState<ComposeResponse | null>(null);
  const composedKeyRef = useRef<string | null>(null);
  /**
   * True when this mount started on a step past the first one — i.e. a reload
   * or a shared link, with no composed post in memory to back it. Computed once
   * in the initialiser: nothing is composed at mount time, so the check cannot
   * be wrong, and no effect has to write state for it.
   */
  const [rewound, setRewound] = useState(() => searchParams.get("step") !== null);
  /** Set when re-composing another code cleared captions typed for the old one. */
  const [captionsCleared, setCaptionsCleared] = useState(false);

  const requestedStep = stepFromSlug(searchParams.get("step"));
  // A step beyond 1 is only valid once there is something composed; otherwise
  // the operator would review a post that does not exist.
  const step = composed ? requestedStep : FIRST_STEP;

  // Sync the URL with reality — the only thing this effect does is navigate.
  // `replace`: an unreachable step must not stay in history for Back to find.
  useEffect(() => {
    if (composed || requestedStep.index === FIRST_STEP.index) return;
    router.replace(pathname, { scroll: false });
  }, [composed, requestedStep.index, router, pathname]);

  const goToStep = useCallback(
    (slug: ComposeStepSlug) => {
      setRewound(false);
      const params = new URLSearchParams(searchParams.toString());
      if (slug === FIRST_STEP.slug) params.delete("step");
      else params.set("step", slug);
      const query = params.toString();
      // `push`, not replace: Back inside the wizard must go one step back.
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
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
      });
    },
    retry: false,
    onSuccess: (result) => {
      const nextKey = composeKey(form.getValues());
      const hadCaptions = Object.values(form.getValues().captions ?? {}).some(
        (text) => text.trim().length > 0,
      );
      // A caption written for another code must never survive into this post.
      if (composedKeyRef.current !== null && composedKeyRef.current !== nextKey && hadCaptions) {
        form.setValue("captions", emptyCaptions(), { shouldDirty: false });
        setCaptionsCleared(true);
      } else {
        setCaptionsCleared(false);
      }
      composedKeyRef.current = nextKey;
      setComposed(result);
      setRewound(false);
    },
    onError: () => {
      // Blocked/failed compose invalidates the current post: step 2 and 3 must
      // not stay reachable with stale data from the previous product.
      setComposed(null);
      composedKeyRef.current = null;
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
  const submitProductStep = useCallback(async () => {
    const valid = await form.trigger([...STEP_PRODUCT_FIELDS]);
    if (!valid) {
      const firstInvalid = STEP_PRODUCT_FIELDS.find((field) => form.getFieldState(field).invalid);
      if (firstInvalid) form.setFocus(firstInvalid);
      return;
    }
    compose.mutate();
  }, [compose, form]);

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
    compose,
    captions,
    submitProductStep,
    rewound,
    captionsCleared,
    /** True once every channel has a non-empty caption (step 3 gate). */
    hasEveryCaption: COMPOSE_CHANNELS.every(
      (channel) => (captionValues?.[channel.id] ?? "").trim().length > 0,
    ),
  };
}

export type ComposeWizard = ReturnType<typeof useComposeWizard>;
