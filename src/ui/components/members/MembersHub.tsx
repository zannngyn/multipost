"use client";

import {
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Stack,
  StackItem,
  Tab,
  TabList,
  Text,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { AccessForbidden } from "@/ui/components/access/AccessForbidden";
import { AccessRequestsScreen } from "@/ui/components/access/AccessRequestsScreen";
import { InvitePanel } from "@/ui/components/members/InvitePanel";
import {
  MEMBERS_TABS,
  MEMBERS_TAB_LABELS,
  MEMBERS_TAB_PARAM,
  parseMembersTab,
  resolveActiveMembersTab,
  type MembersTab,
} from "@/ui/components/members/members-tabs";
import { MembersScreen } from "@/ui/components/members/MembersScreen";
import { useActiveTenant } from "@/ui/hooks/useMe";

/**
 * "Thành viên" — the wave-1 hub over the three views of one subject: who is in
 * this company ("Thành viên"), the links that let new people in ("Link mời")
 * and what the retired approval queue decided about everyone before that
 * ("Lịch sử duyệt"). `/access` redirects here.
 *
 * The hub owns no LIST: each panel keeps its own query and its own loading /
 * data / empty / error states. What it does own is what belongs to the address
 * rather than to a panel — which view is on screen (`?tab=`) — plus the one h1
 * every panel then hangs its h2 under.
 *
 * `TabList`, not `SegmentedControl`: Astryx draws the line at navigation vs
 * input, and "Lịch sử duyệt" used to be a route of its own — the history panel
 * already uses `SegmentedControl` for its status filter, so a second one up
 * here would be two identical-looking controls meaning different things. Tabs
 * are buttons, not links: Astryx's `Tab href` fires `onChange` on top of the
 * anchor's own navigation, so a link tab would navigate twice (same call as
 * `PostsHub` and `ChannelsHub`).
 */
export function MembersHub({
  tab,
  canViewHistory,
  operatorEmail,
}: {
  tab: MembersTab;
  /**
   * `canManageAccess(session)`, decided on the server before this hub was sent
   * (the same rule that guarded `/access` and still guards
   * `GET /api/access-requests`). Carried as a prop because switching tabs is a
   * client-side rewrite: a guard that only ran in the page would be skipped by
   * everyone who reaches the history tab without a fresh document request.
   */
  canViewHistory: boolean;
  /** Named in the refusal so the operator knows which account is being judged. */
  operatorEmail: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // `role`, not `tenant.role`: the hook reports a support session as `viewer`,
  // which is what keeps "Tạo link mời" off in a read-only support session
  // (doc 09 §3.5). Reading the raw membership role here would hand MYSP staff a
  // button whose only outcome is a 403.
  const { role: actorRole, tenant } = useActiveTenant();

  // The URL wins once the client is live (Back/Forward and the redirect from
  // `/access` both land here); `tab` is what the server already parsed, used
  // until the browser has search params of its own.
  const active = resolveActiveMembersTab(searchParams.get(MEMBERS_TAB_PARAM), tab);

  const goToTab = useCallback(
    (next: MembersTab) => {
      if (next === active) return;
      // Only `?tab=` survives the switch: the rest of the query belongs to the
      // view being left (`?status=blocked` is a history filter and would be
      // dead weight on the member list). replace(), not push() — this is one
      // page seen three ways, and pushing would make Back walk the operator
      // through every tab click before it leaves the screen
      // (core-routing-patterns §"Điều hướng").
      router.replace(`${pathname}?${MEMBERS_TAB_PARAM}=${next}`, { scroll: false });
    },
    [active, pathname, router],
  );

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Thành viên</Heading>
              <Text type="supporting">
                Ai đang làm việc trong {tenant?.name ?? "công ty này"} và với quyền gì, những link
                mời đang phát hành, và lịch sử của luồng chờ duyệt cũ. Mỗi công ty có danh sách
                riêng — đổi công ty ở thanh trên cùng để xem công ty khác.
              </Text>
            </Stack>

            {/* The shell's side nav is the other <nav> on the page, so this one
                says what it navigates (core-accessibility §2). */}
            <TabList
              value={active}
              onChange={(value: string) => goToTab(parseMembersTab(value))}
              aria-label="Chế độ xem thành viên"
            >
              {MEMBERS_TABS.map((value) => (
                <Tab key={value} value={value} label={MEMBERS_TAB_LABELS[value]} />
              ))}
            </TabList>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            <StackItem size="fill">
              {active === "invites" ? (
                // Its own tab, so `MembersScreen` must not draw it as well:
                // the url of a fresh invite is shown exactly ONCE and two
                // panels reading the same mutation would be two places for it
                // to appear — and to be lost.
                <Stack direction="vertical" padding={4}>
                  <InvitePanel actorRole={actorRole} />
                </Stack>
              ) : active === "history" ? (
                canViewHistory ? (
                  <AccessRequestsScreen onGoToMembers={() => goToTab("members")} />
                ) : (
                  <AccessForbidden email={operatorEmail} />
                )
              ) : (
                <MembersScreen showInvites={false} />
              )}
            </StackItem>
          </Stack>
        </LayoutContent>
      }
    />
  );
}
