"use client";

import { Badge, Button, HStack, Stack, Text } from "@astryxdesign/core";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useActiveTenant, useSwitchTenant } from "@/ui/hooks/useMe";
import { MEMBERSHIP_ROLE_LABELS, planLabel, type MeTenant } from "@/ui/schemas/me.schema";

/**
 * "Chọn công ty để làm việc" (M1.4).
 *
 * Picking writes the selector cookie through `POST /api/me/active-tenant`; the
 * server re-checks the membership, so a company that is not really yours comes
 * back 404 and is presented as such — the browser cannot select its way in.
 *
 * On success the ENTIRE query cache is dropped (see `useSwitchTenant`): the
 * rows on screen belong to the previous company, and showing them under the new
 * name is a data leak, not a rendering delay.
 */
export function TenantPicker() {
  const { tenants, tenantId } = useActiveTenant();
  const switchTenant = useSwitchTenant();

  const busyId = switchTenant.isPending ? (switchTenant.variables?.tenantId ?? null) : null;

  return (
    <Stack direction="vertical" gap={3}>
      {switchTenant.isError ? <ApiErrorNotice error={switchTenant.error} /> : null}

      <Stack direction="vertical" gap={2} role="list">
        {tenants.map((tenant) => (
          <TenantRow
            key={tenant.id}
            tenant={tenant}
            isActive={tenant.id === tenantId}
            isBusy={busyId === tenant.id}
            isDisabled={switchTenant.isPending}
            onPick={() => {
              switchTenant.reset();
              switchTenant.mutate({ tenantId: tenant.id });
            }}
          />
        ))}
      </Stack>

      {/* Announced without stealing focus: the switch replaces the screen. */}
      <Text type="supporting" role="status" aria-live="polite">
        {switchTenant.isPending ? "Đang chuyển công ty, vui lòng đợi" : ""}
      </Text>
    </Stack>
  );
}

function TenantRow({
  tenant,
  isActive,
  isBusy,
  isDisabled,
  onPick,
}: {
  tenant: MeTenant;
  isActive: boolean;
  isBusy: boolean;
  isDisabled: boolean;
  onPick: () => void;
}) {
  return (
    <HStack
      role="listitem"
      gap={3}
      padding={3}
      align="center"
      justify="between"
      wrap="wrap"
    >
      <Stack direction="vertical" gap={0.5}>
        <HStack gap={2} align="center" wrap="wrap">
          <Text>{tenant.name}</Text>
          {/* Category tags, not system status — plain colour variants. */}
          <Badge variant="blue" label={planLabel(tenant.plan)} />
          {isActive ? <Badge variant="success" label="Đang làm việc" /> : null}
        </HStack>
        <Text type="supporting" color="secondary">
          Vai trò của bạn: {MEMBERSHIP_ROLE_LABELS[tenant.role]}
        </Text>
      </Stack>

      <Button
        variant={isActive ? "secondary" : "primary"}
        size="sm"
        label={isActive ? `Tiếp tục ở ${tenant.name}` : `Chuyển sang ${tenant.name}`}
        isLoading={isBusy}
        isDisabled={isDisabled}
        onClick={onPick}
      >
        {isActive ? "Tiếp tục" : "Chọn"}
      </Button>
    </HStack>
  );
}
