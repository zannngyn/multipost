"use client";

import { ErrorState } from "@/ui/components/feedback/ErrorState";
import { presentApiError, toApiError } from "@/ui/components/feedback/present-api-error";
import { Button } from "@/ui/components/ui/button";

/**
 * Renders any error coming out of the data layer, already classified by
 * `presentApiError`: the retry button appears only when retrying can succeed,
 * and a session error offers the sign-in link instead.
 *
 * Presentational: it never fetches and never decides business outcomes.
 */
export function ApiErrorNotice({
  error,
  onRetry,
  className,
  extraAction,
}: {
  error: unknown;
  /** Ignored for 4xx — a retry there would repeat the same bad request. */
  onRetry?: () => void;
  className?: string;
  extraAction?: React.ReactNode;
}) {
  const apiError = toApiError(error);
  const view = presentApiError(apiError);

  return (
    <ErrorState
      className={className ?? "mx-0 max-w-none"}
      title={view.title}
      description={view.hint ? `${view.description} ${view.hint}` : view.description}
      details={view.details}
      referenceCode={apiError.code}
      onRetry={view.canRetry && onRetry ? onRetry : undefined}
      secondaryAction={
        view.kind === "auth" ? (
          <Button asChild variant="outline">
            <a href="/signin">Đăng nhập lại</a>
          </Button>
        ) : (
          extraAction
        )
      }
    />
  );
}
