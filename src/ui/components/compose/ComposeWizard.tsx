"use client";

import { useEffect, useRef, useState } from "react";

import { ComposeFooterNav } from "@/ui/components/compose/ComposeFooterNav";
import { DraftStatusBar } from "@/ui/components/compose/DraftStatusBar";
import { FacebookPreview } from "@/ui/components/compose/FacebookPreview";
import { StepCaption } from "@/ui/components/compose/StepCaption";
import { StepProduct } from "@/ui/components/compose/StepProduct";
import { StepReview } from "@/ui/components/compose/StepReview";
import { WizardStepper, type StepperStep } from "@/ui/components/compose/WizardStepper";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { useComposeDraft } from "@/ui/hooks/useComposeDraft";
import { usePublishForm } from "@/ui/hooks/usePublishForm";
import { useComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS } from "@/ui/schemas/compose.schema";

/**
 * Compose wizard shell (docs/07 §4.1), laid out as the approved design draws
 * it: the steps as one bar across the top, the work on the left, and the live
 * Facebook preview pinned on the right — on EVERY step, not only while a
 * caption is being written. Seeing the post take shape is the point of the
 * screen; hiding it behind a step was the thing the design fixed.
 *
 * The business order is untouched (CLAUDE.md rule 1): sản phẩm → tồn kho →
 * media → AI → duyệt → đăng. Only the presentation moved.
 *
 * Layout is still the "fixed shell, content scrolls" model (core-layout-shell):
 * the step bar and the action bar hold still, and exactly one region scrolls.
 * Below the container breakpoint the preview drops under the work instead of
 * being squeezed beside it.
 *
 * This file owns four things the steps must not each own a copy of:
 *  - the step header (eyebrow, title), which is also the focus target when the
 *    step changes: without it focus falls back to <body> and a keyboard user is
 *    left with no idea where they are (web-wizard rule 5);
 *  - the scroll region, reset to the top on every step change — the browser's
 *    own restoration watches `window`, which is not what scrolls here;
 *  - the preview column, and which channel's caption it shows;
 *  - the primary action, in the footer, for all three steps. Step 3's action
 *    creates the batch, so it reads the same `usePublishForm` instance the
 *    publish panel renders its fields from.
 */
export function ComposeWizard() {
  const wizard = useComposeWizard();
  const publish = usePublishForm(wizard);
  // Owned here, like `publish`: the status line, the steps and the footer must
  // all be looking at the same draft (E10).
  const draft = useComposeDraft(wizard, publish);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousStep = useRef(wizard.step.index);
  /**
   * Which channel the preview is showing. Phase 1 has exactly one channel, so
   * this is a single value today — but the preview is a frame-level thing now,
   * and it must not silently show channel 1 while the operator types into
   * channel 2 the day a second channel exists.
   */
  const [previewChannelId, setPreviewChannelId] = useState<string>(COMPOSE_CHANNELS[0].id);

  useEffect(() => {
    if (previousStep.current === wizard.step.index) return;
    previousStep.current = wizard.step.index;
    headingRef.current?.focus();
    scrollRef.current?.scrollTo({ top: 0 });
  }, [wizard.step.index]);

  const { composed } = wizard;
  const maxReachedIndex = composed ? (wizard.hasEveryCaption ? 3 : 2) : 1;
  const captionLength = (wizard.captionValues?.[COMPOSE_CHANNELS[0].id] ?? "").trim().length;

  const steps: StepperStep[] = wizard.steps.map((step) => ({
    ...step,
    summary: summarise(step.index, {
      code: composed?.content.code ?? null,
      color: composed?.media[0]?.color ?? null,
      mediaCount: wizard.album.length,
      captionLength,
    }),
  }));

  const nav = navigationFor(wizard.step.index, {
    hasComposed: Boolean(composed),
    hasEveryCaption: wizard.hasEveryCaption,
    publishLabel: publish.submitLabel,
    canPublish: publish.canSubmit,
    hasChannelGroups: publish.groupItems.length > 0,
    selectedChannels: publish.selectedIds.length,
  });

  return (
    // `bg-background` is explicit, not inherited: AppShell paints its own
    // surface behind the content slot, and without this the cards would sit on
    // white and lose the raised/sunken distinction the whole screen relies on.
    <div className="bg-background flex h-full min-h-0 flex-col">
      <WizardStepper
        steps={steps}
        currentIndex={wizard.step.index}
        maxReachedIndex={maxReachedIndex}
        onSelect={wizard.goToStep}
      />

      {/* The one scrolling region of this screen. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-8 lg:px-8"
        style={{ scrollbarGutter: "stable" }}
      >
        {/* The steps size themselves against THIS box, not the viewport: the
            app's own side nav eats a few hundred pixels, so a 1440px window
            leaves a container that is still too narrow for a two-column step.
            Screen breakpoints get that wrong every time (core-layout-shell
            §breakpoint vs container). */}
        <div className="@container mx-auto flex w-full max-w-400 flex-col gap-4">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1.5">
              <Eyebrow>
                Bước {wizard.step.index} / {wizard.steps.length}
              </Eyebrow>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl leading-tight font-semibold tracking-tight outline-none"
              >
                {wizard.step.title}
              </h1>
            </div>

            <p className="text-muted-foreground max-w-prose text-xs leading-relaxed">
              {STEP_LEDE[wizard.step.slug]}
            </p>
          </header>

          <DraftStatusBar draft={draft} />

          {/* Only for the ONE cause this banner can actually speak for: the
              screen was reloaded on an inner step and there was no draft to
              bring it back. A restore that ran and failed says why itself —
              in `draft.notices` and, for a blocked product, in the error
              notice under step 1 with the server's real sentence. Merging the
              two into one "hoặc / hoặc" line hides the real reason. */}
          {wizard.rewound && draft.notices.length === 0 ? (
            <p
              role="status"
              className="border-warning/40 bg-warning/10 text-warning-foreground rounded-xl border px-3.5 py-2.5 text-sm"
            >
              Đã đưa bạn về bước 1: bài đang soạn không còn sau khi tải lại trang, và không có nháp
              nào để khôi phục. Hãy tra lại mã sản phẩm; từ giờ mọi thứ bạn gõ được lưu tự động.
            </p>
          ) : null}

          {/* Announce the step change politely, without moving the screen reader. */}
          <p className="sr-only" role="status" aria-live="polite">
            Bước {wizard.step.index} trên {wizard.steps.length}: {wizard.step.title}
          </p>

          <div className="flex flex-col items-start gap-5 @5xl:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              {wizard.step.slug === "san-pham" ? <StepProduct wizard={wizard} /> : null}
              {wizard.step.slug === "caption" ? (
                <StepCaption wizard={wizard} onPreviewChannel={setPreviewChannelId} />
              ) : null}
              {wizard.step.slug === "xem-lai" ? (
                <StepReview wizard={wizard} publish={publish} />
              ) : null}
            </div>

            {/* `sticky top-0` inside the scroll region: the preview follows a
                long album instead of scrolling away from it. */}
            <FacebookPreview
              caption={wizard.captionValues?.[previewChannelId] ?? ""}
              pageName={PREVIEW_PAGE_NAME}
              media={wizard.album}
              isVideo={Boolean(composed?.video)}
              className="@5xl:sticky @5xl:top-0 @5xl:w-100 @5xl:shrink-0"
            />
          </div>
        </div>
      </div>

      <ComposeFooterNav
        note={nav.note}
        backLabel="Quay lại"
        onBack={() => wizard.goToStep(wizard.steps[wizard.step.index - 2]?.slug ?? "san-pham")}
        backDisabled={wizard.step.index === 1}
        nextLabel={nav.nextLabel}
        nextDisabled={nav.nextDisabled}
        onNext={() => {
          if (wizard.step.index === 3) {
            publish.submit();
            return;
          }
          wizard.goToStep(wizard.steps[wizard.step.index]?.slug ?? "san-pham");
        }}
      />
    </div>
  );
}

/**
 * Stand-in name in the preview: which Page this goes to is a step-3 decision,
 * and naming one here would suggest a choice nobody has made yet.
 */
const PREVIEW_PAGE_NAME = "Trang Facebook của bạn";

/** One sentence per step, in the header where the eye lands first. */
const STEP_LEDE: Record<string, string> = {
  "san-pham":
    "Tra mã trên Sheet, kiểm tồn kho, rồi gom ảnh từ Drive. Tồn kho luôn được kiểm trước khi AI viết bất cứ chữ nào.",
  caption:
    "AI viết nháp, bạn sửa và duyệt lần cuối. Chỉ nội dung trong ô caption được đăng — giá và tồn kho không bao giờ đi kèm.",
  "xem-lai":
    "Xem đúng thứ sẽ lên Facebook, chọn kênh và thời điểm. Không bài nào rời màn hình này nếu bạn không bấm.",
};

/** The bar's per-step detail line. Says what is IN the post, not what the step is called. */
function summarise(
  index: number,
  facts: {
    code: string | null;
    color: string | null;
    mediaCount: number;
    captionLength: number;
  },
): string {
  if (index === 1) {
    if (!facts.code) return "chưa tra mã nào";
    const parts = [facts.code];
    if (facts.color) parts.push(facts.color);
    parts.push(`${facts.mediaCount} file`);
    return parts.join(" · ");
  }
  if (index === 2) {
    return facts.captionLength === 0 ? "chưa có caption" : `${facts.captionLength} ký tự · đã nhập`;
  }
  return "chọn kênh và thời điểm";
}

/**
 * Label, availability and explanation of the footer's primary action.
 *
 * Kept as one pure function so "why can I not go on" is answered in the same
 * place the button is dimmed — the two drifting apart is what leaves an
 * operator staring at a dead button.
 */
function navigationFor(
  index: number,
  state: {
    hasComposed: boolean;
    hasEveryCaption: boolean;
    publishLabel: string;
    canPublish: boolean;
    hasChannelGroups: boolean;
    selectedChannels: number;
  },
): { nextLabel: string; nextDisabled: boolean; note: string } {
  if (index === 1) {
    return {
      nextLabel: "Tiếp: duyệt caption",
      nextDisabled: !state.hasComposed,
      note: state.hasComposed
        ? "Mọi thay đổi được giữ lại khi bạn đi qua lại giữa các bước."
        : "Tra một mã sản phẩm trước — bước duyệt caption cần dữ liệu Sheet và ảnh của mã đó.",
    };
  }

  if (index === 2) {
    return {
      nextLabel: "Tiếp: xem lại",
      nextDisabled: !state.hasEveryCaption,
      note: state.hasEveryCaption
        ? "Mọi thay đổi được giữ lại khi bạn đi qua lại giữa các bước."
        : "Chưa có nội dung. Bài chưa thể chuyển sang bước xem lại.",
    };
  }

  return {
    nextLabel: state.publishLabel,
    nextDisabled: !state.canPublish,
    note: !state.hasChannelGroups
      ? "Chưa có nhóm kênh nào. Tạo nhóm kênh trước khi đăng."
      : state.selectedChannels === 0
        ? "Chọn ít nhất một kênh trước khi tạo lô."
        : "Tự động đăng luôn mặc định TẮT: bài chỉ rời khỏi màn hình này khi có người bấm duyệt.",
  };
}
