"use client";

import {
  Button,
  HStack,
  Stack,
  StatusDot,
  Table,
  Text,
  TextArea,
  Token,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import { useState } from "react";

import {
  SUSPEND_REASON_MIN,
  TENANT_STATUS_LABELS,
  TENANT_STATUS_TONES,
  TenantStatusReasonFormSchema,
  activateConsequence,
  isInternalTenant,
  planLabel,
  suspendConsequence,
  type PlatformTenant,
} from "@/ui/schemas/platform.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * Every company MYSP operates, as rows.
 *
 * "Khoá" is the heaviest button in the product: it locks a whole company out at
 * once. So it is a two-step action with a MANDATORY reason box
 * (core-crud-inline-edit §thang xác nhận, mức 2) — the consequence is spelled
 * out before the click, and the reason is what answers "vì sao công ty này bị
 * khoá" months later.
 *
 * "Mở khoá" goes through the SAME two steps: the server asks for a reason in
 * both directions (`_lib/set-status.ts`), and one book entry without the other
 * would leave a company mysteriously back online.
 *
 * `support` never sees these buttons at all: there is nothing they could ask
 * for to make them work (core-auth-session §ẩn vs vô hiệu hoá). The server
 * refuses them regardless.
 */

/** Table's generic needs an index signature; the fields stay PlatformTenant's. */
type PlatformTenantRow = PlatformTenant & Record<string, unknown>;

export function PlatformTenantTable({
  tenants,
  canAdminister,
  busyTenantId,
  onSuspend,
  onActivate,
  canSupport,
  onEnterSupport,
}: {
  tenants: readonly PlatformTenant[];
  /** super_admin. When false the action column is not rendered at all. */
  canAdminister: boolean;
  busyTenantId: string | null;
  onSuspend: (tenant: PlatformTenant, reason: string) => void;
  onActivate: (tenant: PlatformTenant, reason: string) => void;
  /** support+ — reading a customer's data is the lower bar, not the higher. */
  canSupport: boolean;
  onEnterSupport: (tenant: PlatformTenant) => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  function ask(tenantId: string) {
    setReason("");
    setReasonError(null);
    setConfirmingId(tenantId);
  }

  function confirm(tenant: PlatformTenant) {
    // Validated at the boundary, before anything leaves the browser: the server
    // enforces the same minimum, and a round trip would say the same thing.
    const parsed = TenantStatusReasonFormSchema.safeParse({ reason });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? "Lý do chưa hợp lệ.");
      return;
    }
    setConfirmingId(null);
    setReasonError(null);
    if (tenant.status === "suspended") onActivate(tenant, parsed.data.reason);
    else onSuspend(tenant, parsed.data.reason);
  }

  const columns: TableColumn<PlatformTenantRow>[] = [
    {
      key: "name",
      header: "Công ty",
      width: proportional(2),
      renderCell: (tenant) => (
        <Stack direction="vertical" gap={0.5}>
          <HStack gap={2} align="center" wrap="wrap">
            <Text weight="medium">{tenant.name}</Text>
            {/* The one row where "khoá công ty này" means "khoá chính chúng
                ta" — worth a mark, not worth a colour of its own. */}
            {isInternalTenant(tenant) ? (
              <Token size="sm" color="purple" label="Nội bộ MYSP" />
            ) : null}
          </HStack>
          {tenant.slug ? (
            <Text type="supporting" color="secondary" maxLines={1}>
              /{tenant.slug}
            </Text>
          ) : (
            <Text type="supporting" color="placeholder">
              Chưa có đường dẫn
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: "plan",
      header: "Gói",
      width: pixel(130),
      renderCell: (tenant) => <Token size="sm" color="blue" label={planLabel(tenant.plan)} />,
    },
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(150),
      // A dot plus the word: "đang khoá" is the fact this whole screen turns
      // on, and colour alone must never be the only way to read it
      // (core-accessibility §5).
      renderCell: (tenant) => (
        <HStack gap={2} align="center">
          <StatusDot
            variant={TENANT_STATUS_TONES[tenant.status]}
            label={TENANT_STATUS_LABELS[tenant.status]}
          />
          <Text color={tenant.status === "suspended" ? "primary" : "secondary"}>
            {TENANT_STATUS_LABELS[tenant.status]}
          </Text>
        </HStack>
      ),
    },
    {
      key: "memberCount",
      header: "Thành viên",
      width: pixel(120),
      renderCell: (tenant) => (
        <Text color="secondary" hasTabularNumbers>
          {tenant.memberCount === 0 ? "Chưa có ai" : `${tenant.memberCount} người`}
        </Text>
      ),
    },
    {
      key: "createdAt",
      header: "Ngày tạo",
      width: pixel(170),
      renderCell: (tenant) => (
        <Text color="secondary" hasTabularNumbers>
          {formatDateTime(tenant.createdAt)}
        </Text>
      ),
    },
  ];

  if (canSupport) {
    columns.push({
      key: "support",
      header: "Hỗ trợ",
      width: pixel(150),
      renderCell: (tenant) =>
        tenant.status === "suspended" ? (
          // A locked company answers 403 to everything anyway; offering the
          // door would be offering a dead end.
          <Text color="placeholder">Công ty đang khoá</Text>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            label={`Vào hỗ trợ ${tenant.name}`}
            onClick={() => onEnterSupport(tenant)}
          >
            Vào hỗ trợ
          </Button>
        ),
    });
  }

  if (canAdminister) {
    columns.push({
      key: "actions",
      header: "Thao tác",
      width: pixel(420),
      renderCell: (tenant) => {
        const isBusy = busyTenantId === tenant.id;

        const isSuspended = tenant.status === "suspended";
        const verb = isSuspended ? "mở khoá" : "khoá";

        if (confirmingId === tenant.id) {
          return (
            <Stack direction="vertical" gap={2}>
              <Text type="supporting" color="primary" role="alert">
                {isSuspended
                  ? `Mở khoá ${tenant.name}? ${activateConsequence(tenant)}`
                  : `Khoá ${tenant.name}? ${suspendConsequence(tenant)}`}
                {!isSuspended && isInternalTenant(tenant)
                  ? " Đây là công ty nội bộ của MYSP — khoá nó là khoá chính đội ngũ."
                  : ""}
              </Text>
              <TextArea
                label={`Lý do ${verb} ${tenant.name}`}
                description={`Bắt buộc, ít nhất ${SUSPEND_REASON_MIN} ký tự. Dòng này được lưu lại để đối chiếu về sau.`}
                isRequired
                rows={2}
                value={reason}
                onChange={(value) => {
                  setReason(value);
                  if (reasonError) setReasonError(null);
                }}
                isDisabled={isBusy}
                status={reasonError ? { type: "error", message: reasonError } : undefined}
                statusVariant="detached"
              />
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  variant={isSuspended ? "primary" : "destructive"}
                  label={`Xác nhận ${verb} ${tenant.name}`}
                  isLoading={isBusy}
                  isDisabled={isBusy}
                  onClick={() => confirm(tenant)}
                >
                  {isSuspended ? "Mở khoá công ty" : "Khoá công ty"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  label={`Không ${verb} ${tenant.name}`}
                  isDisabled={isBusy}
                  onClick={() => {
                    setConfirmingId(null);
                    setReasonError(null);
                  }}
                >
                  Giữ nguyên
                </Button>
              </HStack>
            </Stack>
          );
        }

        return (
          <Button
            size="sm"
            variant={isSuspended ? "secondary" : "ghost"}
            label={`${isSuspended ? "Mở khoá" : "Khoá"} ${tenant.name}`}
            isLoading={isBusy}
            isDisabled={isBusy}
            onClick={() => ask(tenant.id)}
          >
            {isSuspended ? "Mở khoá" : "Khoá"}
          </Button>
        );
      },
    });
  }

  return (
    <Stack direction="vertical" isScrollable height="100%">
      <Table
        aria-label="Công ty khách đang chạy trên MYSP"
        data={tenants as PlatformTenantRow[]}
        columns={columns}
        idKey="id"
        density="compact"
        hasHover
        verticalAlign="top"
        textOverflow="truncate"
        rowCount={tenants.length}
      />
    </Stack>
  );
}
