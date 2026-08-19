"use client";

import { useEffect, useRef } from "react";

import { ComposeFooterNav } from "@/ui/components/compose/ComposeFooterNav";
import { DraftStatusBar } from "@/ui/components/compose/DraftStatusBar";
import { StepCaption } from "@/ui/components/compose/StepCaption";
import { StepProduct } from "@/ui/components/compose/StepProduct";
import { StepReview } from "@/ui/components/compose/StepReview";
import { WizardStepper, type StepperStep } from "@/ui/components/compose/WizardStepper";
import { Badge } from "@/ui/components/ui/badge";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { useComposeDraft } from "@/ui/hooks/useComposeDraft";
import { usePublishForm } from "@/ui/hooks/usePublishForm";
import { useComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS, INVENTORY_STATUS_LABELS } from "@/ui/schemas/compose.schema";

/**
 * Compose wizard shell (docs/07 §4.1).
 *
 * Layout is the "fixed shell, content scrolls" model (core-layout-shell): the
 * step rail and the action bar hold still, and exactly one region scrolls. Below
 * `lg` it becomes a single column with the rail as a strip on top — a second
 * render, not the same three-column layout squeezed.
 *
 * This file owns three things the steps must not each own a copy of:
 *  - the step header (eyebrow, title, status badge), which is also the focus
 *    target when the step changes: without it focus falls back to <body> and a
 *    keyboard user is left with no idea where they are (web-wizard rule 5);
 *  - the scroll region, reset to the top on every step change — the browser's
 *    own restoration watches `window`, which is not what scrolls here;
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
    <div className="bg-background flex h-full min-h-0 flex-col lg:flex-row">
      <WizardStepper
        steps={steps}
        currentIndex={wizard.step.index}
        maxReachedIndex={maxReachedIndex}
        onSelect={wizard.goToStep}
        notes={
          <>
            <p className="bg-accent/20 rounded-xl p-3.5 text-xs leading-relaxed">
              <span className="text-foreground block pb-1 font-semibold">Tự động đăng: TẮT</span>
              <span className="text-muted-foreground">
                Bài chỉ rời khỏi màn hình này khi có người bấm duyệt.
              </span>
            </p>
            <p className="bg-muted text-muted-foreground rounded-xl p-3.5 text-xs leading-relaxed">
              Caption chỉ dùng Tên sản phẩm, Chủng loại, Mùa vụ, Mô tả. Giá, tồn kho và ghi chú sản
              xuất không bao giờ đi kèm.
            </p>
          </>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The one scrolling region of this screen. */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-6 pt-7 pb-8 lg:px-8"
          style={{ scrollbarGutter: "stable" }}
        >
          {/* The steps size themselves against THIS box, not the viewport: the
              side nav eats ~256px, so a 1440px window leaves a container that
              is still too narrow for a two-column step. Screen breakpoints get
              that wrong every time (core-layout-shell §breakpoint vs container). */}
          <div className="@container flex flex-col gap-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div className="space-y-2">
                <Eyebrow>
                  Bước {wizard.step.index} / {wizard.steps.length}
                </Eyebrow>
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-3xl leading-tight font-semibold tracking-tight outline-none"
                >
                  {wizard.step.title}
                </h1>
                {wizard.step.slug === "caption" ? (
                  <p className="text-muted-foreground text-sm">
                    AI viết nháp, bạn sửa và duyệt lần cuối. Chỉ nội dung ở đây được đăng.
                  </p>
                ) : null}
              </div>

              {/* Stock belongs to step 1 only (business rule 2): it is internal
                  information, and step 3 is the preview of what goes public. */}
              {wizard.step.slug === "san-pham" && composed?.inventory ? (
                <Badge tone={composed.inventory.status === "in_stock" ? "success" : "warning"}>
                  {INVENTORY_STATUS_LABELS[composed.inventory.status]}
                  {composed.inventory.stock !== null ? ` · tồn ${composed.inventory.stock}` : ""}
                </Badge>
              ) : null}
              {wizard.step.slug === "caption" ? (
                <Badge tone={captionLength > 0 ? "success" : "warning"}>
                  {captionLength > 0 ? `Đã nhập · ${captionLength} ký tự` : "Chưa có caption"}
                </Badge>
              ) : null}
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
                Đã đưa bạn về bước 1: bài đang soạn không còn sau khi tải lại trang, và không có
                nháp nào để khôi phục. Hãy tra lại mã sản phẩm; từ giờ mọi thứ bạn gõ được lưu tự
                động.
              </p>
            ) : null}

            {/* Announce the step change politely, without moving the screen reader. */}
            <p className="sr-only" role="status" aria-live="polite">
              Bước {wizard.step.index} trên {wizard.steps.length}: {wizard.step.title}
            </p>

            {wizard.step.slug === "san-pham" ? <StepProduct wizard={wizard} /> : null}
            {wizard.step.slug === "caption" ? <StepCaption wizard={wizard} /> : null}
            {wizard.step.slug === "xem-lai" ? (
              <StepReview wizard={wizard} publish={publish} />
            ) : null}
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
    </div>
  );
}

/** The rail's per-step detail line. Says what is IN the post, not what the step is called. */
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
