"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useDisconnectGoogle, type GoogleConnectionQuery } from "@/ui/hooks/useGoogleDrive";
import {
  formatConnectedAt,
  googleConnectErrorMessage,
  sourceAccessWarning,
  type GoogleConnection,
  type GoogleConnectOutcome,
  type SourceAccessWarning,
} from "@/ui/schemas/google-drive.schema";
import { googleConnectHref } from "@/ui/services/google-drive.api";

/**
 * The Google Drive connection, at the top of "Nguồn đang đọc" — the primary way
 * in. Pasting a link still works, but it is now the fallback below.
 *
 * Three states that must never be shown as one another:
 *  - `not_connected` — nothing stored yet, one primary action;
 *  - `connected`     — which Google account, since when, and the two things an
 *                      operator does with it (chọn lại nguồn / ngắt kết nối).
 *                      A connected account that CANNOT read the stored source
 *                      gets a warning above that row: the sync would otherwise
 *                      read an empty folder and delete the whole catalogue;
 *  - `expired`       — THE important one: the tenant believes it is configured
 *                      while every sync is failing. It gets warning colours and
 *                      says out loud that syncing stops until it is fixed.
 *    Collapsing it into `not_connected` would hide a running failure
 *    (business rule 5: nothing is silently swallowed).
 *
 * The connect action is a real <a> to `/api/catalog/google/connect`: that route
 * answers 302 to Google, so it has to leave the app. Fetching it would either
 * be blocked by CORS or land Google's consent page in a JSON parser
 * (web-auth-methods §1: redirect, not popup, not XHR).
 */
export function GoogleConnectionPanel({
  tenantId,
  connection,
  outcome,
  onDismissOutcome,
  onPickSource,
  isPicking,
}: {
  tenantId: string;
  connection: GoogleConnectionQuery;
  /** Result of the OAuth round trip, read once from the URL by the screen. */
  outcome: GoogleConnectOutcome | null;
  onDismissOutcome: () => void;
  /** Opens the in-app folder/spreadsheet picker. */
  onPickSource: () => void;
  isPicking: boolean;
}) {
  const disconnect = useDisconnectGoogle(tenantId);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [isConfirmingDisconnect, setIsConfirmingDisconnect] = useState(false);

  const isFirstLoad = connection.isPending && connection.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  // Focus lands on the decision, not on the panel behind it.
  useEffect(() => {
    if (isConfirmingDisconnect) confirmRef.current?.focus();
  }, [isConfirmingDisconnect]);

  // A finished round trip means the stored connection just changed; whatever is
  // cached from before the redirect is out of date by definition.
  const refetchConnection = connection.refetch;
  useEffect(() => {
    if (outcome?.kind === "connected") void refetchConnection();
  }, [outcome, refetchConnection]);

  return (
    <div className="border-border space-y-3 border-b p-4">
      {outcome ? <ConnectOutcomeNotice outcome={outcome} onDismiss={onDismissOutcome} /> : null}

      {/* --- Loading (delayed so a fast answer does not flash) -------------- */}
      {isFirstLoad ? (
        showSkeleton ? (
          <div aria-hidden="true" className="space-y-2 motion-safe:animate-pulse">
            <div className="bg-muted h-4 w-56 rounded" />
            <div className="bg-muted h-8 w-48 rounded-lg" />
          </div>
        ) : null
      ) : connection.isError ? (
        // --- Error: reading the status failed, but CONNECTING does not go
        // through that endpoint, so the operator is not stuck here.
        <ApiErrorNotice
          error={connection.error}
          onRetry={() => void connection.refetch()}
          extraAction={
            <ConnectLink tenantId={tenantId} label="Kết nối Google Drive" variant="outline" />
          }
        />
      ) : connection.data ? (
        <ConnectionFacts
          tenantId={tenantId}
          data={connection.data}
          isPicking={isPicking}
          isDisconnecting={disconnect.isPending}
          isConfirmingDisconnect={isConfirmingDisconnect}
          onPickSource={onPickSource}
          onAskDisconnect={() => setIsConfirmingDisconnect(true)}
        />
      ) : null}

      {isConfirmingDisconnect ? (
        <div
          role="group"
          aria-label="Xác nhận ngắt kết nối Google"
          onKeyDown={(event) => {
            if (event.key === "Escape") setIsConfirmingDisconnect(false);
          }}
          className="border-warning/40 bg-warning/5 space-y-3 rounded-xl border p-4"
        >
          <p className="text-sm font-medium">Ngắt kết nối Google của đơn vị này?</p>
          <p className="text-muted-foreground text-sm">
            Sau khi ngắt, đồng bộ sẽ dừng và không chọn được thư mục/bảng trong app cho tới khi kết
            nối lại. Nguồn đang lưu không bị xoá.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={confirmRef}
              type="button"
              variant="destructive"
              onClick={() => {
                setIsConfirmingDisconnect(false);
                disconnect.mutate();
              }}
            >
              Ngắt kết nối
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsConfirmingDisconnect(false)}>
              Giữ nguyên
            </Button>
          </div>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {disconnect.isPending
          ? "Đang ngắt kết nối Google"
          : isFirstLoad
            ? "Đang đọc trạng thái kết nối Google"
            : ""}
      </p>

      {/* A failed disconnect is never swallowed — the token is still stored. */}
      {disconnect.isError ? <ApiErrorNotice error={disconnect.error} /> : null}
    </div>
  );
}

/** The data state, split out so each `state` narrows on its own. */
function ConnectionFacts({
  tenantId,
  data,
  isPicking,
  isDisconnecting,
  isConfirmingDisconnect,
  onPickSource,
  onAskDisconnect,
}: {
  tenantId: string;
  data: GoogleConnection;
  isPicking: boolean;
  isDisconnecting: boolean;
  isConfirmingDisconnect: boolean;
  onPickSource: () => void;
  onAskDisconnect: () => void;
}) {
  if (data.state === "not_connected") {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Chưa kết nối Google Drive</p>
          <p className="text-muted-foreground max-w-prose text-sm">
            Kết nối để chọn thư mục và bảng ngay trong app, không cần copy link. Hệ thống chỉ xin
            quyền đọc Drive và Google Sheet của tài khoản bạn chọn.
          </p>
        </div>
        <ConnectLink tenantId={tenantId} label="Kết nối Google Drive" />
      </div>
    );
  }

  const connectedAt = formatConnectedAt(data.connectedAt);

  if (data.state === "expired") {
    return (
      <div role="alert" className="border-warning/40 bg-warning/10 space-y-3 rounded-xl border p-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge tone="warning">Kết nối đã hết hạn</Badge>
          <p className="text-sm break-all">{data.email}</p>
        </div>
        <p className="text-sm">
          Kết nối đã hết hạn hoặc bị thu hồi — đồng bộ sẽ dừng cho tới khi kết nối lại. Sản phẩm và
          ảnh đã có vẫn giữ nguyên, nhưng sẽ không được cập nhật.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectLink tenantId={tenantId} label="Kết nối lại Google Drive" />
          <Button
            type="button"
            variant="outline"
            onClick={onAskDisconnect}
            disabled={isDisconnecting || isConfirmingDisconnect}
          >
            {isDisconnecting ? "Đang ngắt…" : "Ngắt kết nối"}
          </Button>
        </div>
        <p className="text-muted-foreground font-mono text-xs">Mã tham chiếu: {data.reason}</p>
      </div>
    );
  }

  const warning = sourceAccessWarning(data.sourceAccess);

  return (
    <div className="space-y-3">
      {/* Above the "đã kết nối" row on purpose: this is the sentence that stops
          an operator from pressing "Chạy đồng bộ" and wiping the catalogue. */}
      {warning ? (
        <SourceAccessNotice warning={warning} onPickSource={onPickSource} isPicking={isPicking} />
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge tone={warning ? "warning" : "success"}>
          {warning ? "Đã kết nối — nguồn chưa đọc được" : "Đã kết nối Google"}
        </Badge>
        <p className="text-sm">
          Tài khoản <span className="font-medium break-all">{data.email}</span>
          {connectedAt ? (
            <span className="text-muted-foreground"> · kết nối lúc {connectedAt}</span>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* When the warning is up it already carries this action as its primary
            button; a second identical button would only split the decision. */}
        {warning ? null : (
          <Button type="button" onClick={onPickSource} disabled={isPicking}>
            Chọn lại thư mục/bảng
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onAskDisconnect}
          disabled={isDisconnecting || isConfirmingDisconnect}
        >
          {isDisconnecting ? "Đang ngắt…" : "Ngắt kết nối"}
        </Button>
      </div>
    </div>
  );
}

/**
 * "The account you just connected cannot read the folder/sheet we have stored."
 *
 * Warning colours, not destructive ones: nothing is broken and nothing is lost
 * yet — the sync will refuse to run, which is the SAFE outcome. Destructive red
 * here would read as "data already gone".
 *
 * `role="status"` (polite), not `alert`: it is part of the status this panel
 * renders when it loads, not something that interrupts mid-task. Assertive
 * would cut across whatever a screen reader is reading (web-feedback-states §4).
 */
function SourceAccessNotice({
  warning,
  onPickSource,
  isPicking,
}: {
  warning: SourceAccessWarning;
  onPickSource: () => void;
  isPicking: boolean;
}) {
  return (
    <div
      role="status"
      className="border-warning/40 bg-warning/10 text-warning-foreground space-y-2.5 rounded-xl border border-l-4 p-3.5"
    >
      <p className="text-sm font-semibold">{warning.title}</p>
      <p className="max-w-prose text-sm">{warning.message}</p>
      <Button type="button" onClick={onPickSource} disabled={isPicking}>
        {warning.actionLabel}
      </Button>
    </div>
  );
}

/**
 * Leaves the app on purpose. `Button asChild` keeps the primary-action styling
 * on a real anchor, so middle-click, "mở tab mới" and the status bar all work.
 */
function ConnectLink({
  tenantId,
  label,
  variant = "default",
}: {
  tenantId: string;
  label: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button asChild variant={variant}>
      <a href={googleConnectHref(tenantId)}>{label}</a>
    </Button>
  );
}

/**
 * What came back from Google. "Người dùng bấm Huỷ" is NOT an error and must not
 * be painted red (web-auth-methods §4) — but it is still said out loud, because
 * a cancelled connect looks exactly like a broken button otherwise.
 */
function ConnectOutcomeNotice({
  outcome,
  onDismiss,
}: {
  outcome: GoogleConnectOutcome;
  onDismiss: () => void;
}) {
  const tone =
    outcome.kind === "connected"
      ? "border-success/30 bg-success/10 text-success-foreground"
      : outcome.kind === "cancelled"
        ? "border-border bg-muted/40 text-foreground"
        : "border-destructive/30 bg-destructive/10 text-destructive";

  const message =
    outcome.kind === "connected"
      ? "Đã kết nối Google Drive. Giờ có thể chọn thư mục ảnh và bảng Sheet ngay trong app."
      : outcome.kind === "cancelled"
        ? "Bạn đã huỷ ở màn hình cấp quyền của Google, nên chưa có kết nối nào được lưu."
        : googleConnectErrorMessage(outcome.reason);

  return (
    <div
      // An error must be announced; a normal outcome must not interrupt.
      role={outcome.kind === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5",
        tone,
      )}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm">{message}</p>
        {outcome.kind === "error" && outcome.reason ? (
          <p className="font-mono text-xs opacity-80">Mã tham chiếu: {outcome.reason}</p>
        ) : null}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
        Đóng
      </Button>
    </div>
  );
}
