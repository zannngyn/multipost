"use client";

import { useEffect, useRef } from "react";

import { StepCaption } from "@/ui/components/compose/StepCaption";
import { StepProduct } from "@/ui/components/compose/StepProduct";
import { StepReview } from "@/ui/components/compose/StepReview";
import { WizardStepper } from "@/ui/components/compose/WizardStepper";
import { useComposeWizard } from "@/ui/hooks/useComposeWizard";

/**
 * Compose wizard shell: owns the step frame, focus handling and the step
 * announcement; each step owns its own fields (docs/07 §4.1).
 *
 * Focus: moving to a new step focuses its heading instead of letting focus fall
 * back to <body>, which would leave a keyboard user lost (web-wizard rule 5).
 * The first render is skipped so the page does not steal focus on load.
 */
export function ComposeWizard() {
  const wizard = useComposeWizard();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(wizard.step.index);

  useEffect(() => {
    if (previousStep.current === wizard.step.index) return;
    previousStep.current = wizard.step.index;
    headingRef.current?.focus();
  }, [wizard.step.index]);

  const maxReachedIndex = wizard.composed ? (wizard.hasEveryCaption ? 3 : 2) : 1;

  return (
    <section className="space-y-6" aria-labelledby="compose-heading">
      <header className="space-y-1">
        <h1 id="compose-heading" className="text-2xl font-semibold tracking-tight">
          Soạn bài
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Thứ tự bắt buộc: tra Sheet → kiểm tồn kho → gom ảnh → viết caption → người duyệt. Hết hàng
          là dừng, không đăng.
        </p>
      </header>

      <WizardStepper
        steps={wizard.steps}
        currentIndex={wizard.step.index}
        maxReachedIndex={maxReachedIndex}
        onSelect={wizard.goToStep}
      />

      {wizard.rewound ? (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
        >
          Đã đưa bạn về bước 1: dữ liệu bài đang soạn không còn (tải lại trang hoặc mở link ở bước
          giữa). Hãy tra lại mã sản phẩm — nội dung không được lưu tạm ở phía máy chủ trong phiên
          bản này.
        </p>
      ) : null}

      {/* Announce the step change politely, without moving the screen reader. */}
      <p className="sr-only" role="status" aria-live="polite">
        Bước {wizard.step.index} trên {wizard.steps.length}: {wizard.step.title}
      </p>

      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        Bước {wizard.step.index}: {wizard.step.title}
      </h2>

      {wizard.step.slug === "san-pham" ? <StepProduct wizard={wizard} /> : null}
      {wizard.step.slug === "caption" ? <StepCaption wizard={wizard} /> : null}
      {wizard.step.slug === "xem-lai" ? <StepReview wizard={wizard} /> : null}
    </section>
  );
}
