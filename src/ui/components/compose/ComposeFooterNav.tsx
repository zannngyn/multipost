"use client";

import { Button } from "@/ui/components/ui/button";

/**
 * The wizard's action bar. Every step's primary action lives here — including
 * step 3's "Tạo lô đăng", which used to sit inside the publish panel — so the
 * operator only ever looks in one place for "what happens next".
 *
 * `note` says WHY the primary action is unavailable when it is. A dimmed button
 * with no explanation is the thing this bar exists to avoid; `disabled` is only
 * ever set together with a note that names the missing piece.
 */
export function ComposeFooterNav({
  note,
  backLabel,
  onBack,
  backDisabled,
  nextLabel,
  onNext,
  nextDisabled,
}: {
  note: string;
  backLabel: string;
  onBack: () => void;
  backDisabled?: boolean;
  nextLabel: string;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <footer className="bg-card border-border flex shrink-0 flex-wrap items-center gap-3 border-t px-6 py-4 lg:h-18 lg:flex-nowrap lg:px-8 lg:py-0">
      <p className="text-muted-foreground order-last w-full text-xs lg:order-first lg:w-auto lg:flex-1">
        {note}
      </p>

      <Button
        type="button"
        variant="secondary"
        onClick={onBack}
        disabled={backDisabled}
        className="h-10 px-4"
      >
        {backLabel}
      </Button>
      <Button type="button" onClick={onNext} disabled={nextDisabled} className="h-10 px-5">
        {nextLabel}
      </Button>
    </footer>
  );
}
