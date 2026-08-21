"use client";

import { DropdownMenu, Text, useAnnounce } from "@astryxdesign/core";
import type { DropdownMenuOption } from "@astryxdesign/core";
import { Building2, Check, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { CreateTenantDialog } from "@/ui/components/tenant/CreateTenantDialog";
import { useActiveTenant, useSwitchTenant } from "@/ui/hooks/useMe";
import { MEMBERSHIP_ROLE_LABELS, planLabel } from "@/ui/schemas/me.schema";

/**
 * The company an operator is working in, and the way to leave it (M2.3 first
 * half) — replaces the static shop name that used to sit in the top bar.
 *
 * Always a menu, even with a single company: it is also the only way to "Tạo
 * công ty mới…", and a control that appears only once you happen to have two
 * companies is a control nobody discovers.
 *
 * Switching drops the whole cache before anything re-renders (see
 * `useSwitchTenant`) — the rows of the previous company must never be shown
 * under the new company's name.
 *
 * `fallbackLabel` is what the SERVER rendered for the first paint. Until
 * `/api/me` answers on the client, using it avoids a flash of "Chọn công ty"
 * over a bar that was already correct.
 */
export function TenantSwitcher({ fallbackLabel }: { fallbackLabel: string | null }) {
  const { tenants, tenantId, tenant, isBootstrapAdmin } = useActiveTenant();
  const switchTenant = useSwitchTenant();
  const announce = useAnnounce();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  /**
   * The switch replaces the screen underneath, so a sighted operator sees the
   * result. Someone on a screen reader would hear nothing at all — the trigger
   * label changes silently — which is what this announcement is for.
   */
  useEffect(() => {
    if (switchTenant.isPending) announce("Đang chuyển công ty, vui lòng đợi.", "polite");
  }, [switchTenant.isPending, announce]);

  useEffect(() => {
    if (!switchTenant.isError) return;
    announce("Không chuyển được công ty. Xem thông báo trong menu công ty.", "assertive");
  }, [switchTenant.isError, announce]);

  const label = tenant?.name ?? fallbackLabel ?? "Chọn công ty";

  const companyItems = tenants.map((item) => {
    const isActive = item.id === tenantId;
    return {
      id: item.id,
      label: item.name,
      description: `${MEMBERSHIP_ROLE_LABELS[item.role]} · ${planLabel(item.plan)}`,
      // A tick AND the position of the item — never colour alone.
      icon: isActive ? <Check aria-hidden="true" /> : undefined,
      // Plain supporting text rather than a badge: badges are for counts, and
      // a green pill next to a tick says the same thing twice, loudly.
      endContent: isActive ? <Text type="supporting">Đang dùng</Text> : undefined,
      isDisabled: switchTenant.isPending,
      onClick: () => {
        // Choosing the company already active is a no-op, not a round trip that
        // wipes the cache for nothing.
        if (isActive) return;
        switchTenant.reset();
        switchTenant.mutate({ tenantId: item.id });
      },
    };
  });

  const items: DropdownMenuOption[] = [
    {
      type: "section",
      title: "Công ty",
      items:
        companyItems.length > 0
          ? companyItems
          : [
              {
                id: "no-company",
                label: isBootstrapAdmin
                  ? "Phiên quản trị hệ thống: không gắn công ty"
                  : "Chưa thuộc công ty nào",
                isDisabled: true,
              },
            ],
    },
    { type: "divider" },
    {
      type: "section",
      items: [
        {
          id: "create-tenant",
          label: "Tạo công ty mới…",
          icon: <Plus aria-hidden="true" />,
          isDisabled: switchTenant.isPending,
          onClick: () => setIsCreateOpen(true),
        },
      ],
    },
  ];

  // A failed switch has to be readable, and the menu is where the click was.
  if (switchTenant.isError) {
    items.splice(1, 0, {
      type: "section",
      items: [
        {
          id: "switch-error",
          label: "Không chuyển được công ty",
          description: switchTenant.error.userMessage,
          variant: "destructive",
          // Keep the menu open: closing it would hide the only explanation.
          hasCloseOnSelect: false,
          isDisabled: true,
        },
      ],
    });
  }

  return (
    <>
      <DropdownMenu
        items={items}
        alignment="start"
        menuWidth={300}
        button={{
          label: switchTenant.isPending ? "Đang chuyển công ty…" : `Công ty: ${label}`,
          // Ghost once a company is established — it is a label you can act on,
          // not an action. With none chosen it is the only thing on the bar the
          // operator must do, so it stops whispering.
          variant: tenant ? "ghost" : "secondary",
          size: "sm",
          icon: <Building2 aria-hidden="true" />,
          isLoading: switchTenant.isPending,
          children: <Text>{label}</Text>,
        }}
      />

      <CreateTenantDialog isOpen={isCreateOpen} onOpenChange={setIsCreateOpen} />
    </>
  );
}
