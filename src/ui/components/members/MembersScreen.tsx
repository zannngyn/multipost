"use client";

import {
  Banner,
  Button,
  Divider,
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
import { InvitePanel } from "@/ui/components/members/InvitePanel";
import { MemberTable } from "@/ui/components/members/MemberTable";
import { MemberTableSkeleton } from "@/ui/components/members/MemberTableSkeleton";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useMembers, useRemoveMember, useUpdateMemberRole } from "@/ui/hooks/useMembers";
import { MEMBERSHIP_ROLE_LABELS, type MembershipRole } from "@/ui/schemas/me.schema";
import { canManageMembers, memberDisplayName, type Member } from "@/ui/schemas/member.schema";

/**
 * "Thành viên" (M2.3): who is in this company, what they may do, and the links
 * that let new people in.
 *
 * Frame (`astryx docs layout`, tracker archetype): header carries the title,
 * the content region carries the invite block and then the rows edge-to-edge.
 *
 * The four mandatory states live in `MemberListBody`:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — one row per member, actions behind a confirmation
 *   empty   — practically unreachable (you are always in your own company), so
 *             it reads as the diagnostic it would be, not as an invitation
 *   error   — 4xx (403 thiếu quyền) vs 5xx (thử lại), via `presentApiError`
 *
 * Everything the operator's own role forbids is disabled WITH ITS REASON in the
 * row; the server still decides, and its 403/409 lands in the notice above the
 * table (core-auth-session: quyền ở client là UX, không phải bảo mật).
 */
export function MembersScreen() {
  const { role: actorRole, tenant, isResolved } = useActiveTenant();
  const members = useMembers();
  const updateRole = useUpdateMemberRole();
  const remove = useRemoveMember();

  /** What the last write did — announced, and shown as a banner. */
  const [outcome, setOutcome] = useState<string | null>(null);

  const items = members.data?.items ?? [];
  const isFirstLoad = members.isPending && members.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const busyMembershipId = updateRole.isPending
    ? (updateRole.variables?.membershipId ?? null)
    : remove.isPending
      ? (remove.variables?.membershipId ?? null)
      : null;

  function handleChangeRole(member: Member, role: MembershipRole) {
    const name = memberDisplayName(member);
    setOutcome(null);
    remove.reset();
    updateRole.reset();
    updateRole.mutate(
      { membershipId: member.membershipId, isYou: member.isYou, role },
      {
        onSuccess: () =>
          setOutcome(
            member.isYou
              ? `Vai trò của bạn trong ${tenant?.name ?? "công ty này"} giờ là ${MEMBERSHIP_ROLE_LABELS[role]}.`
              : `${name} giờ có vai trò ${MEMBERSHIP_ROLE_LABELS[role]}.`,
          ),
      },
    );
  }

  function handleRemove(member: Member) {
    const name = memberDisplayName(member);
    setOutcome(null);
    updateRole.reset();
    remove.reset();
    remove.mutate(
      { membershipId: member.membershipId, isYou: member.isYou },
      {
        onSuccess: () =>
          setOutcome(
            member.isYou
              ? "Bạn đã rời công ty này."
              : `Đã gỡ ${name} khỏi công ty. Muốn thêm lại thì gửi một link mời mới.`,
          ),
      },
    );
  }

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Thành viên</Heading>
              <Text type="supporting">
                Ai đang làm việc trong {tenant?.name ?? "công ty này"} và với quyền gì. Mỗi công ty
                có danh sách thành viên riêng — đổi công ty ở thanh trên cùng để xem công ty khác.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label={members.isFetching ? "Đang tải…" : "Tải lại"}
                isDisabled={members.isFetching}
                onClick={() => void members.refetch()}
              />
              {/* Said once, at the top: it explains every disabled button below
                  before the operator hovers one to find out. */}
              {isResolved && !canManageMembers(actorRole) ? (
                <Text type="supporting">
                  Vai trò của bạn ({actorRole ? MEMBERSHIP_ROLE_LABELS[actorRole] : "không rõ"}) chỉ
                  xem được danh sách.
                </Text>
              ) : null}
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

            {/* A refused write belongs next to the table it was aimed at — 403
                (thiếu quyền) and 409 LAST_OWNER both land here, never as a
                toast that disappears before it is read. */}
            {updateRole.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ApiErrorNotice error={updateRole.error} />
              </Stack>
            ) : null}
            {remove.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ApiErrorNotice error={remove.error} />
              </Stack>
            ) : null}

            <Stack direction="vertical" padding={4}>
              <InvitePanel actorRole={actorRole} />
            </Stack>

            <Divider />

            <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
              <Heading level={2}>Danh sách thành viên</Heading>
              {/* Only once the list is real: "0 thành viên" while loading reads
                  as an answer, and an admin would act on it. */}
              {members.data ? (
                <Text type="supporting" role="status" aria-live="polite">
                  {items.length} thành viên
                </Text>
              ) : null}
            </HStack>

            <StackItem size="fill">
              <MemberListBody
                isFirstLoad={isFirstLoad}
                showSkeleton={showSkeleton}
                isError={members.isError}
                error={members.error}
                onRetry={() => void members.refetch()}
                items={items}
                actorRole={actorRole}
                busyMembershipId={busyMembershipId}
                onChangeRole={handleChangeRole}
                onRemove={handleRemove}
              />
            </StackItem>
          </Stack>
        </LayoutContent>
      }
    />
  );
}

function MemberListBody({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  items,
  actorRole,
  busyMembershipId,
  onChangeRole,
  onRemove,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  items: readonly Member[];
  actorRole: MembershipRole | null;
  busyMembershipId: string | null;
  onChangeRole: (member: Member, role: MembershipRole) => void;
  onRemove: (member: Member) => void;
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <MemberTableSkeleton /> : null;

  // --- Error, with nothing to fall back on ---------------------------------
  if (isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={error} onRetry={onRetry} />
      </Stack>
    );
  }

  // --- Empty: you are always a member of the company you are looking at, so
  // an empty list is a symptom, not a starting point.
  if (items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          headingLevel={3}
          title="Danh sách thành viên đang trống"
          description="Kể cả bạn cũng không có trong danh sách, nên nhiều khả năng máy chủ trả về thiếu. Tải lại; nếu vẫn trống, báo quản trị viên hệ thống."
          actions={<Button variant="secondary" label="Tải lại" onClick={onRetry} />}
        />
      </Stack>
    );
  }

  // --- Data, possibly STALE -------------------------------------------------
  // A refetch failed while rows from an earlier answer are still on screen.
  // Hiding that would let an admin change a role against a list the server no
  // longer agrees with.
  return (
    <Stack direction="vertical" height="100%">
      {isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          <Banner
            status="warning"
            title="Danh sách bên dưới có thể đã cũ — chưa làm mới được"
            description={`${presentApiError(toApiError(error)).description} Những gì đang hiện là kết quả của lần tải gần nhất; hãy thử lại trước khi đổi quyền của ai.`}
            endContent={<Button variant="secondary" size="sm" label="Thử lại" onClick={onRetry} />}
          />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <MemberTable
          members={items}
          actorRole={actorRole}
          busyMembershipId={busyMembershipId}
          onChangeRole={onChangeRole}
          onRemove={onRemove}
        />
      </StackItem>
    </Stack>
  );
}
