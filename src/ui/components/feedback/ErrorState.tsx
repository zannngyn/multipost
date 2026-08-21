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
  /**
   * Whether to pull focus onto the message when it appears. Default `true`,
   * which is what every caller relied on before this prop existed.
   *
   * Set `false` for a message that is NOT the whole screen's answer — a notice
   * about one of several sources on a dashboard, for instance. Focus is a
   * single resource: two boundaries mounting together would fight over it, and
   * stealing it from someone mid-sentence is worse than staying put, since
   * `role="alert"` announces the text either way.
   */
  shouldFocus?: boolean;
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
  shouldFocus = true,
  className,
}: ErrorStateProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasBody = (details && details.length > 0) || referenceCode !== undefined;

  // Move focus to the alert so keyboard/screen-reader users land on the message.
  useEffect(() => {
    if (!shouldFocus) return;
    containerRef.current?.focus();
  }, [shouldFocus]);

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
          <Stack direction="horizontal" gap={2}>
            {onRetry ? (
              <Button type="button" variant="primary" size="sm" label={retryLabel} onClick={onRetry} />
            ) : null}
            {secondaryAction}
          </Stack>
        ) : undefined
      }
    >
      {hasBody ? (
        <Stack direction="vertical" gap={1}>
          {details?.map((line) => (
            <Text key={line} type="supporting" display="block">
              {line}
            </Text>
          ))}
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
