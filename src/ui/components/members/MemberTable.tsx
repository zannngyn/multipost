"use client";

import {
  Button,
  HStack,
  Selector,
  Stack,
  StatusDot,
  Table,
  Text,
  Token,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import { useState } from "react";

import { MEMBERSHIP_ROLE_LABELS, type MembershipRole } from "@/ui/schemas/me.schema";
import {
  ACCESS_ROLE_DESCRIPTIONS,
  type AccessRole,
} from "@/ui/schemas/access-request.schema";
import {
  assignableRoles,
  memberActionBlockReason,
  memberDisplayName,
  memberStatusLabel,
  removeMemberConsequence,
  roleChangeBlockReason,
  type Member,
} from "@/ui/schemas/member.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * The company's members as rows (`astryx docs layout`: dense data an admin
 * scans belongs in a table, not in cards).
 *
 * Both actions ask first, in place — the same two-step shape as
 * `CatalogSourceForm` and the channels screen, so the gesture is identical
 * everywhere in the app. "Gỡ" is the heavy one, so its question SPELLS OUT the
 * consequence (core-crud-inline-edit §thang xác nhận, mức 2: say what is lost)
 * instead of asking "chắc chưa?".
 *
 * What the ladder forbids is disabled here WITH ITS REASON in a tooltip — a
 * dead control with no explanation is the thing core-auth-session forbids. The
 * server still decides: a 403/409 lands in the notice above the table.
 *
 * Role is a category (Token), status is a state (StatusDot + its label in
 * words). Badges are left for counts, so nothing in the list shouts by default.
 */

/** Table's generic needs an index signature; the fields stay Member's. */
type MemberRow = Member & Record<string, unknown>;

/**
 * Role is a CATEGORY, so it reads as a token, not a badge (astryx docs layout:
 * badges are for counts and enumerated states). The ladder is legible at a
 * glance because the colours climb with it: owner > admin > editor > viewer.
 */
const ROLE_TOKEN_COLORS: Record<MembershipRole, "purple" | "blue" | "teal" | "gray"> = {
  owner: "purple",
  admin: "blue",
  editor: "teal",
  viewer: "gray",
};

/**
 * Status is a STATE, so it reads as a dot plus its label in words — never
 * colour alone (core-accessibility §5). `memberStatusLabel` tolerates an
 * unknown status from the server, so this map needs the same fallback.
 */
const MEMBER_STATUS_TONES: Record<string, "success" | "warning" | "neutral"> = {
  active: "success",
  suspended: "warning",
  removed: "neutral",
};

interface PendingAction {
  membershipId: string;
  kind: "role" | "remove";
}

export function MemberTable({
  members,
  actorRole,
  busyMembershipId,
  onChangeRole,
  onRemove,
}: {
  members: readonly Member[];
  /** The signed-in operator's role in THIS company, from `/api/me`. */
  actorRole: MembershipRole | null;
  /** The row with a write in flight — its buttons show progress. */
  busyMembershipId: string | null;
  onChangeRole: (member: Member, role: MembershipRole) => void;
  onRemove: (member: Member) => void;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  /** The role about to be granted, while the question is open. */
  const [draftRole, setDraftRole] = useState<MembershipRole | null>(null);

  const grantable = assignableRoles(actorRole);
  const roleOptions = grantable.map((role) => ({
    value: role,
    label: `${MEMBERSHIP_ROLE_LABELS[role]} — ${ACCESS_ROLE_DESCRIPTIONS[role as AccessRole]}`,
  }));

  function askRole(member: Member) {
    // Opens on the member's CURRENT role when it is one the actor may grant,
    // otherwise on the first grantable one — never on a value that would be
    // refused the moment it is confirmed.
    setDraftRole(grantable.includes(member.role) ? member.role : (grantable[0] ?? null));
    setPending({ membershipId: member.membershipId, kind: "role" });
  }

  const columns: TableColumn<MemberRow>[] = [
    {
      key: "displayName",
      header: "Thành viên",
      width: proportional(2),
      renderCell: (member) => (
        <Stack direction="vertical" gap={0.5}>
          <HStack gap={2} align="center" wrap="wrap">
            <Text weight="medium">{memberDisplayName(member)}</Text>
            {member.isYou ? <Text type="supporting">(bạn)</Text> : null}
          </HStack>
          {member.email?.trim() ? (
            // One line with a tooltip: a long address must not push the row
            // taller than every other row in the list.
            <Text type="supporting" maxLines={1}>
              {member.email}
            </Text>
          ) : (
            <Text type="supporting" color="placeholder">
              Không có email — đăng nhập bằng tài khoản mạng xã hội
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: "role",
      header: "Vai trò",
      width: pixel(150),
      renderCell: (member) => (
        <Token size="sm" color={ROLE_TOKEN_COLORS[member.role]} label={MEMBERSHIP_ROLE_LABELS[member.role]} />
      ),
    },
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(140),
      renderCell: (member) => (
        <HStack gap={2} align="center">
          <StatusDot
            variant={MEMBER_STATUS_TONES[member.status] ?? "neutral"}
            label={memberStatusLabel(member.status)}
          />
          <Text color={member.status === "active" ? "secondary" : "primary"}>
            {memberStatusLabel(member.status)}
          </Text>
        </HStack>
      ),
    },
    {
      key: "joinedAt",
      header: "Vào công ty",
      width: pixel(170),
      renderCell: (member) => (
        <Text color="secondary" hasTabularNumbers>
          {formatDateTime(member.joinedAt)}
        </Text>
      ),
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(420),
      renderCell: (member) => {
        const name = memberDisplayName(member);
        const isBusy = busyMembershipId === member.membershipId;
        const isAsking = pending?.membershipId === member.membershipId;
        const blockedReason = memberActionBlockReason(actorRole, member);

        // --- Step 2a: change role ------------------------------------------
        if (isAsking && pending?.kind === "role") {
          const nextRole = draftRole;
          const refusal =
            nextRole === null
              ? "Bạn không cấp được vai trò nào."
              : roleChangeBlockReason(actorRole, member, nextRole);

          return (
            <Stack direction="vertical" gap={2}>
              <Text type="supporting" color="primary" role="alert">
                Đổi vai trò của {name}
                {member.isYou ? " (chính bạn)" : ""}?
                {member.isYou
                  ? " Quyền của bạn trong công ty này đổi ngay sau khi lưu."
                  : " Người này sẽ có đúng quyền của vai trò mới ngay lập tức."}
              </Text>
              <Selector
                label={`Vai trò mới cho ${name}`}
                isLabelHidden
                size="sm"
                width={260}
                options={roleOptions}
                value={nextRole ?? undefined}
                onChange={(value) => setDraftRole(value as MembershipRole)}
              />
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  variant="primary"
                  label={`Xác nhận đổi vai trò của ${name}`}
                  isLoading={isBusy}
                  isDisabled={isBusy || refusal !== null}
                  tooltip={refusal ?? undefined}
                  onClick={() => {
                    if (nextRole === null || refusal !== null) return;
                    setPending(null);
                    onChangeRole(member, nextRole);
                  }}
                >
                  Lưu vai trò
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  label={`Huỷ đổi vai trò của ${name}`}
                  isDisabled={isBusy}
                  onClick={() => setPending(null)}
                >
                  Huỷ
                </Button>
              </HStack>
            </Stack>
          );
        }

        // --- Step 2b: remove, with the consequence spelled out --------------
        if (isAsking && pending?.kind === "remove") {
          return (
            <Stack direction="vertical" gap={2}>
              <Text type="supporting" color="primary" role="alert">
                Gỡ {member.isYou ? "chính bạn" : name} khỏi công ty?{" "}
                {removeMemberConsequence(member)}
              </Text>
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  variant="destructive"
                  label={`Xác nhận gỡ ${name} khỏi công ty`}
                  isLoading={isBusy}
                  isDisabled={isBusy}
                  onClick={() => {
                    setPending(null);
                    onRemove(member);
                  }}
                >
                  {member.isYou ? "Rời công ty" : "Gỡ khỏi công ty"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  label={`Giữ ${name} trong công ty`}
                  isDisabled={isBusy}
                  onClick={() => setPending(null)}
                >
                  Giữ lại
                </Button>
              </HStack>
            </Stack>
          );
        }

        // --- Step 1 ---------------------------------------------------------
        return (
          <HStack gap={2} align="center" wrap="wrap">
            <Button
              size="sm"
              variant="secondary"
              label={`Đổi vai trò của ${name}`}
              isLoading={isBusy}
              isDisabled={isBusy || blockedReason !== null || roleOptions.length === 0}
              tooltip={blockedReason ?? undefined}
              onClick={() => askRole(member)}
            >
              Đổi vai trò
            </Button>
            <Button
              size="sm"
              variant="ghost"
              label={member.isYou ? "Rời công ty" : `Gỡ ${name} khỏi công ty`}
              isDisabled={isBusy || blockedReason !== null}
              tooltip={blockedReason ?? undefined}
              onClick={() => setPending({ membershipId: member.membershipId, kind: "remove" })}
            >
              {member.isYou ? "Rời công ty" : "Gỡ"}
            </Button>
          </HStack>
        );
      },
    },
  ];

  return (
    <Stack direction="vertical" isScrollable height="100%">
      <Table
        aria-label="Thành viên của công ty"
        data={members as MemberRow[]}
        columns={columns}
        idKey="membershipId"
        density="compact"
        hasHover
        verticalAlign="top"
        textOverflow="truncate"
        rowCount={members.length}
      />
    </Stack>
  );
}
