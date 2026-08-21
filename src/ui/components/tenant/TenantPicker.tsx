"use client";

import {
  Button,
  Card,
  HStack,
  List,
  ListItem,
  Stack,
  StatusDot,
  Text,
  Token,
} from "@astryxdesign/core";

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
 *
 * One bordered list of rows, not a card per company: this is a list to scan and
 * pick from, and a card per record is the "card soup" Astryx's layout guidance
 * rules out. `List` owns the row semantics and the dividers.
 */
export function TenantPicker() {
  const { tenants, tenantId } = useActiveTenant();
  const switchTenant = useSwitchTenant();

  const busyId = switchTenant.isPending ? (switchTenant.variables?.tenantId ?? null) : null;

  return (
    <Stack direction="vertical" gap={3}>
      {switchTenant.isError ? <ApiErrorNotice error={switchTenant.error} /> : null}

      <Card padding={2}>
        <List hasDividers density="spacious">
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
        </List>
      </Card>

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
    <ListItem
      label={tenant.name}
      description={
        <HStack gap={2} align="center" wrap="wrap">
          {/* Category tag, not system status. */}
          <Token size="sm" color="gray" label={planLabel(tenant.plan)} />
          <Text type="supporting">Vai trò của bạn: {MEMBERSHIP_ROLE_LABELS[tenant.role]}</Text>
          {/* Dot AND word: the current row must not be marked by colour alone. */}
          {isActive ? (
            <HStack gap={1} align="center">
              <StatusDot variant="success" label="Đang làm việc" />
              <Text type="supporting">Đang làm việc</Text>
            </HStack>
          ) : null}
        </HStack>
      }
      endContent={
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
      }
    />
  );
}
