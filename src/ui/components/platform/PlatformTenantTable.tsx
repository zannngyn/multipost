"use client";

import {
  Badge,
  Button,
  HStack,
  MoreMenu,
  Stack,
  Table,
  Text,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";

import { TenantStatusDialog } from "@/ui/components/platform/TenantStatusDialog";
import {
  TENANT_STATUS_LABELS,
  TENANT_STATUS_TONES,
  isInternalTenant,
  planLabel,
  type PlatformTenant,
} from "@/ui/schemas/platform.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * Every company MYSP operates, as rows.
 *
 * "Khoá" is the heaviest action in the product: it locks a whole company out at
 * once. So it is a two-step action with a MANDATORY reason box
 * (core-crud-inline-edit §thang xác nhận, mức 2) — the consequence is spelled
 * out before the click, and the reason is what answers "vì sao công ty này bị
 * khoá" months later. The confirmation itself lives in `TenantStatusDialog`.
 *
 * "Mở khoá" goes through the SAME two steps: the server asks for a reason in
 * both directions (`_lib/set-status.ts`), and one book entry without the other
 * would leave a company mysteriously back online.
 *
 * WHY THE "⋯" MENU (spec §3.2): "Khoá" and "Vào hỗ trợ" used to sit side by
 * side as two buttons of the same size, one row apart from each other — the
 * everyday action and the one that takes a customer offline, offered at the
 * same weight, a mis-click apart. The dangerous one now lives behind an
 * overflow menu as a destructive item, which is what `core-layout-shell`
 * §adaptive and Astryx's own MoreMenu guidance both ask for: keep the primary
 * action visible, put the rest one deliberate click away. "Vào hỗ trợ" stays a
 * plain button in its own column — reading a customer's data is the LOWER bar,
 * and burying it would only make support slower.
 *
 * `support` never sees the menu at all: there is nothing they could ask for to
 * make it work (core-auth-session §ẩn vs vô hiệu hoá). The server refuses the
 * write regardless.
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
  /**
   * Resolved from the LIVE list, not remembered from the click: a refetch can
   * land between opening the confirmation and confirming it, and the sentence
   * the operator reads has to describe the company as it is now.
   */
  const confirmingTenant =
    confirmingId === null ? null : (tenants.find((tenant) => tenant.id === confirmingId) ?? null);

  /**
   * The row left the answer WHILE its confirmation was open — a refetch dropped
   * it, or another admin removed it. `confirmingTenant` is already null so the
   * dialog is off the screen, but `confirmingId` would still point at that row,
   * and the NEXT refetch bringing the row back would resolve it again and pop
   * the confirmation open on its own — in front of an operator who never asked
   * for it, pre-armed to lock a company. The intent dies with the row.
   *
   * Adjusted DURING render, not in an effect: React re-runs this component
   * immediately with the new state and nothing intermediate reaches the screen
   * ("You Might Not Need an Effect" §Adjusting state when a prop changes). An
   * effect would paint one frame with a stale `confirmingId`, and `react-hooks`
   * rejects `setState` in an effect body for exactly that reason.
   */
  if (confirmingId !== null && confirmingTenant === null) {
    setConfirmingId(null);
  }

  /**
   * The "⋯" trigger of each row, so the keyboard can be given back to the
   * control that opened the confirmation. Astryx's Dialog restores focus to
   * whatever was focused when it opened — here that is the MENU ITEM, which is
   * gone by then, so without this the keyboard lands on <body> and the operator
   * starts the page over. Measured before the fix: `document.activeElement` was
   * BODY after "Giữ nguyên".
   */
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>());
  /** Which row to hand focus back to once the confirmation is gone. */
  const returnFocusTo = useRef<string | null>(null);
  /**
   * The fallback landing spot for the keyboard: the list itself. Used when the
   * row that opened the confirmation is no longer in the answer, so there is no
   * "⋯" left to give focus back to. <body> is not an option — a keyboard on
   * <body> means the operator starts the page over.
   */
  const listRef = useRef<HTMLElement | null>(null);

  /**
   * A passive effect in the PARENT of the dialog, so it runs after the dialog's
   * own restore and gets the last word (the same call `PromptTemplatesScreen`
   * makes for its reuse dialog). Focusing inside the click handler would be
   * overwritten by that restore.
   */
  useEffect(() => {
    if (confirmingId !== null) return;
    const rowId = returnFocusTo.current;
    if (rowId === null) return;
    // Consumed either way: carrying the intent to some later, unrelated open
    // would be worse than dropping it.
    returnFocusTo.current = null;
    const trigger = triggerRefs.current.get(rowId) ?? null;
    if (trigger !== null) {
      trigger.focus();
      return;
    }
    // The row — and its trigger with it — left the list. The list is the
    // nearest thing that still exists, and it keeps the keyboard on this
    // screen, one Tab away from the rows that remain.
    listRef.current?.focus();
  }, [confirmingId]);

  function ask(tenantId: string) {
    returnFocusTo.current = tenantId;
    setConfirmingId(tenantId);
  }

  function confirm(tenant: PlatformTenant, reason: string) {
    // Same order as before the dialog existed: the confirmation goes away, the
    // row takes over the "đang lưu" state, and the screen announces the result.
    setConfirmingId(null);
    if (tenant.status === "suspended") onActivate(tenant, reason);
    else onSuspend(tenant, reason);
  }

  const columns: TableColumn<PlatformTenantRow>[] = [
    {
      key: "name",
      header: "Công ty",
      width: proportional(2),
      renderCell: (tenant) => (
        <Stack direction="vertical" gap={0.5}>
          <HStack gap={2} align="center" wrap="wrap">
            <Text>{tenant.name}</Text>
            {/* The one row where "khoá công ty này" means "khoá chính chúng
                ta" — worth a mark, not worth a colour of its own. */}
            {isInternalTenant(tenant) ? <Badge variant="purple" label="Nội bộ MYSP" /> : null}
          </HStack>
          {tenant.slug ? (
            <Text type="supporting" color="secondary">
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
      renderCell: (tenant) => <Badge variant="blue" label={planLabel(tenant.plan)} />,
    },
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(150),
      renderCell: (tenant) => (
        <Badge
          variant={TENANT_STATUS_TONES[tenant.status]}
          label={TENANT_STATUS_LABELS[tenant.status]}
        />
      ),
    },
    {
      key: "memberCount",
      header: "Thành viên",
      width: pixel(120),
      renderCell: (tenant) => (
        <Text color="secondary">
          {tenant.memberCount === 0 ? "Chưa có ai" : `${tenant.memberCount} người`}
        </Text>
      ),
    },
    {
      key: "createdAt",
      header: "Ngày tạo",
      width: pixel(170),
      renderCell: (tenant) => <Text color="secondary">{formatDateTime(tenant.createdAt)}</Text>,
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
      width: pixel(150),
      renderCell: (tenant) => {
        const isBusy = busyTenantId === tenant.id;
        const isSuspended = tenant.status === "suspended";

        return (
          <HStack gap={2} align="center" wrap="wrap">
            <MoreMenu
              ref={(node) => {
                triggerRefs.current.set(tenant.id, node);
                // React 19 ref cleanup: a row that leaves the answer must not
                // leave a detached button behind in the map.
                return () => {
                  triggerRefs.current.delete(tenant.id);
                };
              }}
              size="sm"
              alignment="end"
              label={`Thao tác với ${tenant.name}`}
              isDisabled={isBusy}
              items={[
                {
                  // Locking is the destructive direction; unlocking is recovery
                  // and is not painted as a danger it is not.
                  label: isSuspended ? "Mở khoá công ty" : "Khoá công ty",
                  variant: isSuspended ? undefined : "destructive",
                  onClick: () => ask(tenant.id),
                },
              ]}
            />
            {/* The busy affordance the row's button used to carry. Not a live
                region: `PlatformScreen` already owns one, and one per row would
                make a single save speak five times. */}
            {isBusy ? (
              <Text type="supporting" color="secondary">
                Đang lưu…
              </Text>
            ) : null}
          </HStack>
        );
      },
    });
  }

  return (
    <Stack
      direction="vertical"
      isScrollable
      height="100%"
      ref={listRef}
      // Programmatic target only (never in the tab order): where focus goes
      // when the row it belonged to is gone. A scroll region you can reach with
      // the keyboard is what `core-accessibility` asks for anyway.
      tabIndex={-1}
    >
      <Table
        data={tenants as PlatformTenantRow[]}
        columns={columns}
        idKey="id"
        density="compact"
        hasHover
        verticalAlign="top"
        textOverflow="truncate"
        rowCount={tenants.length}
      />

      {/* Keyed on the row so every open starts on an empty reason box — a
          reason typed for one company can never ride over to another. */}
      {confirmingTenant ? (
        <TenantStatusDialog
          key={confirmingTenant.id}
          tenant={confirmingTenant}
          isBusy={busyTenantId === confirmingTenant.id}
          onCancel={() => setConfirmingId(null)}
          onConfirm={confirm}
        />
      ) : null}
    </Stack>
  );
}
