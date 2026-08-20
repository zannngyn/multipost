"use client";

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Stack,
  StackItem,
  Text,
} from "@astryxdesign/core";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { presentApiError, toApiError } from "@/ui/components/feedback/present-api-error";
import { CreatePlatformTenantDialog } from "@/ui/components/platform/CreatePlatformTenantDialog";
import { PlatformTenantTable } from "@/ui/components/platform/PlatformTenantTable";
import { PlatformTenantTableSkeleton } from "@/ui/components/platform/PlatformTenantTableSkeleton";
import { SupportSessionDialog } from "@/ui/components/platform/SupportSessionDialog";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useMe } from "@/ui/hooks/useMe";
import {
  useActivatePlatformTenant,
  usePlatformTenants,
  useSuspendPlatformTenant,
} from "@/ui/hooks/usePlatformTenants";
import {
  canAdministerPlatform,
  canViewPlatform,
  platformActionBlockReason,
  platformRoleLabel,
  type PlatformTenant,
} from "@/ui/schemas/platform.schema";

/**
 * "Công ty khách" (M3.2): every company MYSP operates, seen from outside all of
 * them.
 *
 * This screen is NOT tenant-scoped — a platform admin may hold no membership
 * anywhere — so it reads no active tenant and its query key carries none
 * (`TenantBoundary` lets `/platform` through for the same reason).
 *
 * Two audiences, one screen: `support` reads it, `super_admin` acts on it. The
 * action column simply is not rendered for support, and the header says why
 * once rather than leaving a row of dead buttons (core-auth-session §ẩn vs vô
 * hiệu hoá — there is nothing support could ask for to make them work).
 *
 * The four mandatory states live in `PlatformListBody`:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — one row per company; suspend behind a reason box
 *   empty   — a deployment with no company at all is a diagnostic, not a start
 *   error   — 403 (sai vai trò nền tảng) vs 5xx (thử lại), via `presentApiError`
 */
export function PlatformScreen() {
  const me = useMe();
  const platformRole = me.data?.account?.platformRole ?? null;
  const canAdminister = canAdministerPlatform(platformRole);

  const tenants = usePlatformTenants();
  const suspend = useSuspendPlatformTenant();
  const activate = useActivatePlatformTenant();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  /** The row whose "Vào hỗ trợ" was pressed — null keeps the dialog closed. */
  const [supportTarget, setSupportTarget] = useState<PlatformTenant | null>(null);
  /** What the last write did — announced, and shown as a banner. */
  const [outcome, setOutcome] = useState<string | null>(null);

  const items = tenants.data?.items ?? [];
  const isFirstLoad = tenants.isPending && tenants.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const busyTenantId = suspend.isPending
    ? (suspend.variables?.tenantId ?? null)
    : activate.isPending
      ? (activate.variables?.tenantId ?? null)
      : null;

  function handleSuspend(tenant: PlatformTenant, reason: string) {
    setOutcome(null);
    activate.reset();
    suspend.reset();
    suspend.mutate(
      { tenantId: tenant.id, reason },
      {
        onSuccess: () =>
          setOutcome(
            `Đã khoá ${tenant.name}. Thành viên của công ty này không vào được cho tới khi mở khoá.`,
          ),
      },
    );
  }

  function handleActivate(tenant: PlatformTenant, reason: string) {
    setOutcome(null);
    suspend.reset();
    activate.reset();
    activate.mutate(
      { tenantId: tenant.id, reason },
      { onSuccess: () => setOutcome(`Đã mở khoá ${tenant.name}. Thành viên vào lại được ngay.`) },
    );
  }

  const supportNotice = platformActionBlockReason(platformRole);

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <HStack gap={2} align="center" wrap="wrap">
                <Heading level={1}>Công ty khách</Heading>
                <Badge
                  variant={canAdminister ? "purple" : "neutral"}
                  label={platformRoleLabel(platformRole)}
                />
              </HStack>
              <Text type="supporting">
                Toàn bộ công ty đang chạy trên MYSP. Màn này đứng ngoài mọi công ty — thao tác ở đây
                ảnh hưởng tới khách, không tới công ty bạn đang làm việc.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label={tenants.isFetching ? "Đang tải…" : "Tải lại"}
                isDisabled={tenants.isFetching}
                onClick={() => void tenants.refetch()}
              />
              {canAdminister ? (
                <Button
                  variant="primary"
                  size="sm"
                  label="Tạo công ty cho khách"
                  onClick={() => setIsCreateOpen(true)}
                />
              ) : null}
              {/* Said once, at the top, instead of a column of dead buttons. */}
              {supportNotice ? <Text type="supporting">{supportNotice}</Text> : null}
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {/* The live region is ALWAYS mounted, empty most of the time: a
                region that appears together with its text is announced
                unreliably (web-feedback-states §4). */}
            <Stack
              direction="vertical"
              role="status"
              aria-live="polite"
              paddingInline={4}
              paddingBlock={outcome ? 3 : 0}
            >
              {outcome ? (
                <Banner
                  status="success"
                  isDismissable
                  onDismiss={() => setOutcome(null)}
                  title="Đã lưu thay đổi"
                  description={outcome}
                />
              ) : null}
            </Stack>

            {/* A refused write belongs next to the table it was aimed at. */}
            {suspend.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ApiErrorNotice error={suspend.error} operation="platform" />
              </Stack>
            ) : null}
            {activate.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ApiErrorNotice error={activate.error} operation="platform" />
              </Stack>
            ) : null}

            <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
              <Heading level={2}>Danh sách công ty</Heading>
              {/* Only once the list is real: "0 công ty" while loading reads as
                  an answer, and somebody would act on it. */}
              {tenants.data ? (
                <Text type="supporting" role="status" aria-live="polite">
                  {items.length} công ty
                </Text>
              ) : null}
            </HStack>

            <StackItem size="fill">
              <PlatformListBody
                isFirstLoad={isFirstLoad}
                showSkeleton={showSkeleton}
                isError={tenants.isError}
                error={tenants.error}
                onRetry={() => void tenants.refetch()}
                items={items}
                canAdminister={canAdminister}
                canSupport={canViewPlatform(platformRole)}
                busyTenantId={busyTenantId}
                onSuspend={handleSuspend}
                onActivate={handleActivate}
                onEnterSupport={setSupportTarget}
              />
            </StackItem>
          </Stack>

          {canAdminister ? (
            <CreatePlatformTenantDialog isOpen={isCreateOpen} onOpenChange={setIsCreateOpen} />
          ) : null}

          <SupportSessionDialog
            tenant={supportTarget}
            isOpen={supportTarget !== null}
            onOpenChange={(open) => {
              if (!open) setSupportTarget(null);
            }}
          />
        </LayoutContent>
      }
    />
  );
}

function PlatformListBody({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  items,
  canAdminister,
  canSupport,
  busyTenantId,
  onSuspend,
  onActivate,
  onEnterSupport,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  items: readonly PlatformTenant[];
  canAdminister: boolean;
  canSupport: boolean;
  busyTenantId: string | null;
  onSuspend: (tenant: PlatformTenant, reason: string) => void;
  onActivate: (tenant: PlatformTenant, reason: string) => void;
  onEnterSupport: (tenant: PlatformTenant) => void;
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <PlatformTenantTableSkeleton /> : null;

  // --- Error, with nothing to fall back on ---------------------------------
  if (isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={error} onRetry={onRetry} operation="platform" />
      </Stack>
    );
  }

  // --- Empty: MYSP always operates at least its own workspace --------------
  if (items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          headingLevel={3}
          title="Chưa có công ty nào"
          description="Ngay cả công ty nội bộ của MYSP cũng không có trong danh sách, nên nhiều khả năng máy chủ trả về thiếu. Tải lại; nếu vẫn trống, kiểm tra dữ liệu nền tảng."
          actions={<Button variant="secondary" label="Tải lại" onClick={onRetry} />}
        />
      </Stack>
    );
  }

  // --- Data, possibly STALE -------------------------------------------------
  // A refetch failed while rows from an earlier answer are still on screen.
  // Hiding that would let someone suspend a company against a list the server
  // no longer agrees with.
  return (
    <Stack direction="vertical" height="100%">
      {isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          <Banner
            status="warning"
            title="Danh sách bên dưới có thể đã cũ — chưa làm mới được"
            description={`${presentApiError(toApiError(error), { operation: "platform" }).description} Những gì đang hiện là kết quả của lần tải gần nhất; hãy thử lại trước khi khoá công ty nào.`}
            endContent={<Button variant="secondary" size="sm" label="Thử lại" onClick={onRetry} />}
          />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <PlatformTenantTable
          tenants={items}
          canAdminister={canAdminister}
          canSupport={canSupport}
          busyTenantId={busyTenantId}
          onSuspend={onSuspend}
          onActivate={onActivate}
          onEnterSupport={onEnterSupport}
        />
      </StackItem>
    </Stack>
  );
}
