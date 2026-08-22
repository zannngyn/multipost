"use client";

import { Banner, Link } from "@astryxdesign/core";

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
  shouldFocus,
  source,
}: {
  error: unknown;
  /** Ignored for 4xx — a retry there would repeat the same bad request. */
  onRetry?: () => void;
  className?: string;
  extraAction?: React.ReactNode;
  /**
   * Passed straight to `ErrorState` (default: focus the message). Set `false`
   * where this notice is one of several on a screen that still works — see the
   * prop's own note there.
   */
  shouldFocus?: boolean;
  /**
   * The action that failed, when its wording differs from the default
   * publish/read one (see `ApiErrorOperation`). Only the title and the next
   * step change; the reason still comes from the server.
   */
  operation?: ApiErrorOperation;
  /**
   * WHICH list failed, when the screen shows more than one notice at a time.
   *
   * It goes INTO the title rather than above the notice: a label sitting on top
   * of a heading is a kicker, and a notice that already has a heading does not
   * need a second one. Prefixed, never a replacement — the classified title
   * ("Phiên đăng nhập đã kết thúc") is the diagnosis and must survive.
   */
  source?: string;
}) {
  const apiError = toApiError(error);
  const view = presentApiError(apiError, operation ? { operation } : undefined);
  const sourceName = source?.trim() ?? "";
  const title = sourceName.length > 0 ? `${sourceName} — ${view.title}` : view.title;

  // 409 TENANT_NOT_SELECTED is a fork in the road, not a failure: the company
  // picker is already on screen (see TenantBoundary), so this only has to say
  // what to do next — in an informational tone, never red (doc 10 §3).
  if (view.kind === "select-tenant") {
    return (
      <Banner
        className={className}
        role="status"
        status="info"
        title={title}
        description={view.hint ? `${view.description} ${view.hint}` : view.description}
        endContent={extraAction}
      />
    );
  }

  return (
    <ErrorState
      className={className}
      title={title}
      description={view.hint ? `${view.description} ${view.hint}` : view.description}
      details={view.details}
      referenceCode={apiError.code}
      shouldFocus={shouldFocus}
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
