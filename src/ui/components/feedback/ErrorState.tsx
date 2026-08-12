"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/shared/utils";
import { Button } from "@/ui/components/ui/button";

export interface ErrorStateProps {
  title: string;
  /** What happened + why + what to do next. Vietnamese, no stack traces. */
  description: string;
  /** Short reference shown to operators for support ("Mã: a91f..."). */
  referenceCode?: string;
  /** Omit to hide the retry button (403/404 — retrying is pointless). */
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra action rendered next to retry (e.g. "Về trang chủ"). */
  secondaryAction?: React.ReactNode;
  className?: string;
}

/**
 * Shared error block for route/segment/widget boundaries.
 * Presentational only: no fetching, no business branching.
 */
export function ErrorState({
  title,
  description,
  referenceCode,
  onRetry,
  retryLabel = "Thử lại",
  secondaryAction,
  className,
}: ErrorStateProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Move focus to the alert so keyboard/screen-reader users land on the message.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="alert"
      tabIndex={-1}
      className={cn(
        "border-destructive/30 bg-destructive/5 mx-auto flex w-full max-w-xl flex-col items-start gap-3 rounded-xl border p-6 outline-none",
        className,
      )}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>

      {referenceCode ? (
        <p className="text-muted-foreground/80 font-mono text-xs">Mã tham chiếu: {referenceCode}</p>
      ) : null}

      {onRetry || secondaryAction ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {onRetry ? (
            <Button type="button" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
