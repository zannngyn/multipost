"use client";

import { Link } from "@astryxdesign/core";

import { ErrorState } from "@/ui/components/feedback/ErrorState";
import {
  presentApiError,
  toApiError,
  type ApiErrorOperation,
} from "@/ui/components/feedback/present-api-error";

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
  operation,
}: {
  error: unknown;
  /** Ignored for 4xx — a retry there would repeat the same bad request. */
  onRetry?: () => void;
  className?: string;
  extraAction?: React.ReactNode;
  /**
   * The action that failed, when its wording differs from the default
   * publish/read one (see `ApiErrorOperation`). Only the title and the next
   * step change; the reason still comes from the server.
   */
  operation?: ApiErrorOperation;
}) {
  const apiError = toApiError(error);
  const view = presentApiError(apiError, operation ? { operation } : undefined);

  return (
    <ErrorState
      className={className}
      title={view.title}
      description={view.hint ? `${view.description} ${view.hint}` : view.description}
      details={view.details}
      referenceCode={apiError.code}
      onRetry={view.canRetry && onRetry ? onRetry : undefined}
      secondaryAction={
        view.kind === "auth" ? (
          // A real anchor, not a button: signing in again is navigation, and
          // Astryx Button has no `asChild` to wrap one.
          <Link href="/signin" isStandalone>
            Đăng nhập lại
          </Link>
        ) : (
          extraAction
        )
      }
    />
  );
}
