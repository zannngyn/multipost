"use client";

import {
  Banner,
  Button,
  HStack,
  Skeleton,
  Stack,
  StatusDot,
  Text,
  VisuallyHidden,
} from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
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
 * Every tinted panel here is a `Banner`: severity now comes from the design
 * system's own status scale instead of a hand-mixed border/background pair, so
 * "cảnh báo" looks the same on this screen as it does on every other.
 *
 * The connect action is a real link to `/api/catalog/google/connect`: that route
 * answers 302 to Google, so it has to leave the app. Fetching it would either
 * be blocked by CORS or land Google's consent page in a JSON parser
 * (web-auth-methods §1: redirect, not popup, not XHR).
 */
export function GoogleConnectionPanel({
  connection,
  outcome,
  onDismissOutcome,
  onPickSource,
  isPicking,
}: {
  connection: GoogleConnectionQuery;
  /** Result of the OAuth round trip, read once from the URL by the screen. */
  outcome: GoogleConnectOutcome | null;
  onDismissOutcome: () => void;
  /** Opens the in-app folder/spreadsheet picker. */
  onPickSource: () => void;
  isPicking: boolean;
}) {
  const disconnect = useDisconnectGoogle();
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
    <Stack direction="vertical" gap={3} padding={4}>
      {outcome ? <ConnectOutcomeNotice outcome={outcome} onDismiss={onDismissOutcome} /> : null}

      {/* --- Loading (delayed so a fast answer does not flash) -------------- */}
      {isFirstLoad ? (
        showSkeleton ? (
          <Stack direction="vertical" gap={2} aria-hidden="true">
            <Skeleton width={224} height={16} />
            <Skeleton width={192} height={32} />
          </Stack>
        ) : null
      ) : connection.isError ? (
        // --- Error: reading the status failed, but CONNECTING does not go
        // through that endpoint, so the operator is not stuck here.
        <ApiErrorNotice
          error={connection.error}
          onRetry={() => void connection.refetch()}
          extraAction={<ConnectLink label="Kết nối Google Drive" variant="secondary" />}
        />
      ) : connection.data ? (
        <ConnectionFacts
          data={connection.data}
          isPicking={isPicking}
          isDisconnecting={disconnect.isPending}
          isConfirmingDisconnect={isConfirmingDisconnect}
          onPickSource={onPickSource}
          onAskDisconnect={() => setIsConfirmingDisconnect(true)}
        />
      ) : null}

      {isConfirmingDisconnect ? (
        <Stack
          direction="vertical"
          role="group"
          aria-label="Xác nhận ngắt kết nối Google"
          onKeyDown={(event) => {
            if (event.key === "Escape") setIsConfirmingDisconnect(false);
          }}
        >
          <Banner
            status="warning"
            title="Ngắt kết nối Google của đơn vị này?"
            description="Sau khi ngắt, đồng bộ sẽ dừng và không chọn được thư mục/bảng trong app cho tới khi kết nối lại. Nguồn đang lưu không bị xoá."
            endContent={
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  ref={confirmRef}
                  variant="destructive"
                  label="Ngắt kết nối"
                  onClick={() => {
                    setIsConfirmingDisconnect(false);
                    disconnect.mutate();
                  }}
                />
                <Button
                  variant="secondary"
                  label="Giữ nguyên"
                  onClick={() => setIsConfirmingDisconnect(false)}
                />
              </HStack>
            }
          />
        </Stack>
      ) : null}

      <VisuallyHidden as="div" role="status" aria-live="polite">
        {disconnect.isPending
          ? "Đang ngắt kết nối Google"
          : isFirstLoad
            ? "Đang đọc trạng thái kết nối Google"
            : ""}
      </VisuallyHidden>

      {/* A failed disconnect is never swallowed — the token is still stored. */}
      {disconnect.isError ? <ApiErrorNotice error={disconnect.error} /> : null}
    </Stack>
  );
}

/** The data state, split out so each `state` narrows on its own. */
function ConnectionFacts({
  data,
  isPicking,
  isDisconnecting,
  isConfirmingDisconnect,
  onPickSource,
  onAskDisconnect,
}: {
  data: GoogleConnection;
  isPicking: boolean;
  isDisconnecting: boolean;
  isConfirmingDisconnect: boolean;
  onPickSource: () => void;
  onAskDisconnect: () => void;
}) {
  if (data.state === "not_connected") {
    return (
      <Stack direction="vertical" gap={3}>
        <Stack direction="vertical" gap={1}>
          <HStack gap={2} align="center">
            <StatusDot variant="neutral" label="Chưa kết nối" />
            <Text weight="medium">Chưa kết nối Google Drive</Text>
          </HStack>
          <Text type="supporting">
            Kết nối để chọn thư mục và bảng ngay trong app, không cần copy link. Hệ thống chỉ xin
            quyền đọc Drive và Google Sheet của tài khoản bạn chọn.
          </Text>
        </Stack>
        <ConnectLink label="Kết nối Google Drive" />
      </Stack>
    );
  }

  /**
   * Field-level (M3.3): a viewer receives `{state}` and nothing else, so every
   * detail below is optional. Absent is rendered as ABSENT — never as an empty
   * string next to a label, which reads as "hệ thống mất dữ liệu".
   */
  const connectedAt = data.connectedAt ? formatConnectedAt(data.connectedAt) : null;

  if (data.state === "expired") {
    return (
      <Banner
        role="alert"
        status="warning"
        title="Kết nối Google đã hết hạn"
        description={`Kết nối đã hết hạn hoặc bị thu hồi — đồng bộ sẽ dừng cho tới khi kết nối lại. Sản phẩm và ảnh đã có vẫn giữ nguyên, nhưng sẽ không được cập nhật.${
          data.reason ? ` Mã tham chiếu: ${data.reason}.` : ""
        }`}
        endContent={
          <HStack gap={2} align="center" wrap="wrap">
            <ConnectLink label="Kết nối lại Google Drive" />
            <Button
              variant="secondary"
              label={isDisconnecting ? "Đang ngắt…" : "Ngắt kết nối"}
              isDisabled={isDisconnecting || isConfirmingDisconnect}
              onClick={onAskDisconnect}
            />
          </HStack>
        }
      >
        {data.email ? (
          <Text type="code" size="2xs" wordBreak="break-all">
            {data.email}
          </Text>
        ) : null}
      </Banner>
    );
  }

  /**
   * `undefined` = the account may not see this fact; `"unknown"` = it was
   * checked and produced no conclusion. Only the second one is worth a warning
   * — telling a viewer "nguồn chưa đọc được" from a field they never received
   * would be inventing an incident.
   */
  const warning = data.sourceAccess ? sourceAccessWarning(data.sourceAccess) : null;

  return (
    <Stack direction="vertical" gap={3}>
      {/* Above the "đã kết nối" row on purpose: this is the sentence that stops
          an operator from pressing "Chạy đồng bộ" and wiping the catalogue. */}
      {warning ? (
        <SourceAccessNotice warning={warning} onPickSource={onPickSource} isPicking={isPicking} />
      ) : null}

      <Stack direction="vertical" gap={1}>
        <HStack gap={2} align="center" wrap="wrap">
          <StatusDot
            variant={warning ? "warning" : "success"}
            label={warning ? "Đã kết nối nhưng chưa đọc được nguồn" : "Đã kết nối"}
          />
          <Text weight="medium">
            {warning ? "Đã kết nối — nguồn chưa đọc được" : "Đã kết nối Google"}
          </Text>
        </HStack>

        {data.email ? (
          <Text type="supporting">
            Tài khoản{" "}
            <Text color="primary" weight="medium" wordBreak="break-all">
              {data.email}
            </Text>
            {connectedAt ? ` · kết nối lúc ${connectedAt}` : ""}
          </Text>
        ) : (
          // The connection itself is public to the tenant; WHICH account it is
          // is not. Saying so beats a blank space where a name should be.
          <Text type="supporting">Chi tiết tài khoản chỉ hiện với quản trị viên của đơn vị.</Text>
        )}
      </Stack>

      <HStack gap={2} align="center" wrap="wrap">
        {/* When the warning is up it already carries this action as its primary
            button; a second identical button would only split the decision. */}
        {warning ? null : (
          <Button
            variant="primary"
            label="Chọn lại thư mục/bảng"
            isDisabled={isPicking}
            onClick={onPickSource}
          />
        )}
        <Button
          variant="secondary"
          label={isDisconnecting ? "Đang ngắt…" : "Ngắt kết nối"}
          isDisabled={isDisconnecting || isConfirmingDisconnect}
          onClick={onAskDisconnect}
        />
      </HStack>
    </Stack>
  );
}

/**
 * "The account you just connected cannot read the folder/sheet we have stored."
 *
 * Warning status, not error: nothing is broken and nothing is lost yet — the
 * sync will refuse to run, which is the SAFE outcome. Red here would read as
 * "data already gone".
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
    <Banner
      role="status"
      status="warning"
      title={warning.title}
      description={warning.message}
      endContent={
        <Button
          variant="primary"
          label={warning.actionLabel}
          isDisabled={isPicking}
          onClick={onPickSource}
        />
      }
    />
  );
}

/**
 * Leaves the app on purpose. Astryx `Button href` renders a real anchor with
 * button styling, so middle-click, "mở tab mới" and the status bar all work.
 */
function ConnectLink({
  label,
  variant = "primary",
}: {
  label: string;
  variant?: "primary" | "secondary";
}) {
  // A plain <a>, not the app router: this route 302s out to Google.
  return <Button variant={variant} label={label} href={googleConnectHref()} as="a" />;
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
  const status =
    outcome.kind === "connected" ? "success" : outcome.kind === "cancelled" ? "info" : "error";

  const message =
    outcome.kind === "connected"
      ? "Đã kết nối Google Drive. Giờ có thể chọn thư mục ảnh và bảng Sheet ngay trong app."
      : outcome.kind === "cancelled"
        ? "Bạn đã huỷ ở màn hình cấp quyền của Google, nên chưa có kết nối nào được lưu."
        : googleConnectErrorMessage(outcome.reason);

  return (
    <Banner
      // An error must be announced; a normal outcome must not interrupt.
      role={outcome.kind === "error" ? "alert" : "status"}
      status={status}
      title={message}
      description={
        outcome.kind === "error" && outcome.reason
          ? `Mã tham chiếu: ${outcome.reason}`
          : undefined
      }
      isDismissable
      onDismiss={onDismiss}
    />
  );
}
