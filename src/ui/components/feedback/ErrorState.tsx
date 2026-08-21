"use client";

import { Banner, Button, Stack, Text } from "@astryxdesign/core";
import { useEffect, useRef } from "react";

export interface ErrorStateProps {
  title: string;
  /** What happened + why + what to do next. Vietnamese, no stack traces. */
  description: string;
  /** One line per reason when an error has several (e.g. video specs). */
  details?: readonly string[];
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
 *
 * The props are unchanged from the shadcn version on purpose — every screen
 * still calls it the same way while the migration runs.
 */
export function ErrorState({
  title,
  description,
  details,
  referenceCode,
  onRetry,
  retryLabel = "Thử lại",
  secondaryAction,
  className,
}: ErrorStateProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasBody = (details && details.length > 0) || referenceCode !== undefined;

  // Move focus to the alert so keyboard/screen-reader users land on the message.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <Banner
      ref={containerRef}
      role="alert"
      tabIndex={-1}
      className={className}
      status="error"
      title={title}
      description={description}
      // Children sit in a collapsed area by default; the reference code and the
      // per-reason lines are part of the message, not an optional detail.
      defaultIsExpanded={hasBody}
      endContent={
        onRetry || secondaryAction ? (
          <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
            {onRetry ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                label={retryLabel}
                onClick={onRetry}
              />
            ) : null}
            {secondaryAction}
          </Stack>
        ) : undefined
      }
    >
      {hasBody ? (
        // Reasons first, reference code last and quieter: the operator reads
        // the reasons, support reads the code.
        <Stack direction="vertical" gap={2}>
          {details && details.length > 0 ? (
            <Stack direction="vertical" gap={1}>
              {details.map((line) => (
                <Text key={line} type="supporting" color="primary" display="block">
                  {line}
                </Text>
              ))}
            </Stack>
          ) : null}
          {referenceCode ? (
            <Text type="code" color="secondary" display="block">
              Mã tham chiếu: {referenceCode}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Banner>
  );
}
