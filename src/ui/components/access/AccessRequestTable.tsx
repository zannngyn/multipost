"use client";

import {
  Badge,
  Button,
  HStack,
  Selector,
  Stack,
  StatusDot,
  Table,
  Text,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import { useState } from "react";

import {
  ACCESS_PROVIDER_LABELS,
  ACCESS_PROVIDER_TONES,
  ACCESS_REQUEST_STATUS_LABELS,
  ACCESS_REQUEST_STATUS_TONES,
  ACCESS_ROLES,
  ACCESS_ROLE_DESCRIPTIONS,
  ACCESS_ROLE_LABELS,
  DEFAULT_ACCESS_ROLE,
  accessRequestDisplayName,
  accessRequestEmailLabel,
  hasEmail,
  type AccessDecision,
  type AccessRequest,
  type AccessRole,
} from "@/ui/schemas/access-request.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * Access requests as rows, not cards (`astryx docs layout`: dense data an admin
 * scans belongs in a table).
 *
 * Status is a StatusDot plus its label in text — never colour alone
 * (core-accessibility §5).
 *
 * BOTH actions ask first, in place: the action cell swaps to a question, and
 * only the second click sends anything. That mirrors the confirmation step of
 * `CatalogSourceForm` (and the "gỡ" flow of `ChannelTable`), so the gesture is
 * the same everywhere in the app. No `confirm()`: it cannot be styled, blocks
 * the main thread and is announced inconsistently across browsers.
 *
 * "Chặn" is the heavy one, so its question spells out the consequence instead
 * of asking "chắc chưa?" — an admin must be told what happens BEFORE clicking,
 * not discover it when a colleague cannot sign in.
 */

/** Table's generic needs an index signature; the fields stay AccessRequest's. */
type AccessRequestRow = AccessRequest & Record<string, unknown>;

/** Which row is asking, and about what. Pure view state, so it lives here. */
interface PendingDecision {
  id: string;
  decision: AccessDecision;
}

const ROLE_OPTIONS = ACCESS_ROLES.map((role) => ({
  value: role,
  label: `${ACCESS_ROLE_LABELS[role]} — ${ACCESS_ROLE_DESCRIPTIONS[role]}`,
}));

export function AccessRequestTable({
  items,
  busyId,
  onDecide,
}: {
  items: readonly AccessRequest[];
  /** The row with a decision in flight — its buttons show progress. */
  busyId: string | null;
  onDecide: (request: AccessRequest, decision: AccessDecision, role: AccessRole) => void;
}) {
  const [pending, setPending] = useState<PendingDecision | null>(null);
  /** The role about to be granted. Reset every time a question is opened. */
  const [role, setRole] = useState<AccessRole>(DEFAULT_ACCESS_ROLE);

  function ask(id: string, decision: AccessDecision) {
    setRole(DEFAULT_ACCESS_ROLE);
    setPending({ id, decision });
  }

  function confirm(request: AccessRequest, decision: AccessDecision) {
    setPending(null);
    onDecide(request, decision, role);
  }

  const columns: TableColumn<AccessRequestRow>[] = [
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(140),
      renderCell: (request) => (
        <HStack gap={2} align="center">
          <StatusDot
            variant={ACCESS_REQUEST_STATUS_TONES[request.status]}
            label={ACCESS_REQUEST_STATUS_LABELS[request.status]}
          />
          <Text>{ACCESS_REQUEST_STATUS_LABELS[request.status]}</Text>
        </HStack>
      ),
    },
    {
      key: "displayName",
      header: "Người dùng",
      width: proportional(2),
      renderCell: (request) => (
        <Stack direction="vertical" gap={0.5}>
          <Text>{accessRequestDisplayName(request)}</Text>
          {/* A provider that sent no e-mail is a fact, not a blank cell — and
              never the string "null". */}
          {hasEmail(request.email) ? (
            <Text type="supporting">{accessRequestEmailLabel(request.email)}</Text>
          ) : (
            <Text type="supporting" color="placeholder">
              Không có email — nhận diện bằng mã tài khoản
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: "provider",
      header: "Đăng nhập bằng",
      width: pixel(140),
      renderCell: (request) => (
        <Badge
          variant={ACCESS_PROVIDER_TONES[request.provider]}
          label={ACCESS_PROVIDER_LABELS[request.provider]}
        />
      ),
    },
    {
      key: "providerAccountId",
      header: "Mã tài khoản",
      width: pixel(170),
      renderCell: (request) => <Text color="secondary">{request.providerAccountId}</Text>,
    },
    {
      key: "role",
      header: "Vai trò",
      width: pixel(130),
      renderCell: (request) =>
        request.role === null ? (
          <Text color="placeholder">Chưa có</Text>
        ) : (
          <Text>{ACCESS_ROLE_LABELS[request.role]}</Text>
        ),
    },
    {
      key: "requestedAt",
      header: "Lúc yêu cầu",
      width: pixel(170),
      renderCell: (request) => <Text color="secondary">{formatDateTime(request.requestedAt)}</Text>,
    },
    {
      key: "decidedAt",
      header: "Ai quyết định",
      width: proportional(1),
      renderCell: (request) =>
        request.decidedAt === null && request.decidedByEmail === null ? (
          <Text color="placeholder">Chưa quyết định</Text>
        ) : (
          <Stack direction="vertical" gap={0.5}>
            <Text type="supporting">{request.decidedByEmail ?? "Không rõ người quyết định"}</Text>
            <Text type="supporting" color="secondary">
              {formatDateTime(request.decidedAt)}
            </Text>
          </Stack>
        ),
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(420),
      renderCell: (request) => {
        const name = accessRequestDisplayName(request);
        const isBusy = busyId === request.id;
        const isAsking = pending?.id === request.id;

        // --- Step 2a: approve, with the role about to be granted ------------
        if (isAsking && pending?.decision === "approve") {
          return (
            <Stack direction="vertical" gap={2}>
              {/* Announced on mount: a keyboard user must hear the question,
                  not just see the buttons change. */}
              <Text type="supporting" role="alert">
                Duyệt {name}? Người này sẽ đăng nhập được ngay ở lần đăng nhập kế tiếp.
              </Text>
              <Selector
                label={`Vai trò cấp cho ${name}`}
                isLabelHidden
                size="sm"
                width={260}
                options={ROLE_OPTIONS}
                value={role}
                onChange={(value) => setRole(value as AccessRole)}
              />
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  variant="primary"
                  label={`Xác nhận duyệt ${name}`}
                  isLoading={isBusy}
                  isDisabled={isBusy}
                  onClick={() => confirm(request, "approve")}
                >
                  Duyệt với vai trò {ACCESS_ROLE_LABELS[role]}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  label={`Huỷ duyệt ${name}`}
                  isDisabled={isBusy}
                  onClick={() => setPending(null)}
                >
                  Huỷ
                </Button>
              </HStack>
            </Stack>
          );
        }

        // --- Step 2b: block, with the consequence spelled out ---------------
        if (isAsking && pending?.decision === "block") {
          return (
            <Stack direction="vertical" gap={2}>
              <Text type="supporting" role="alert">
                Chặn {name}? Tài khoản này sẽ bị từ chối ngay ở màn đăng nhập và không xem được gì
                trong hệ thống. Có thể duyệt lại sau ở bộ lọc “Đã chặn”.
              </Text>
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  variant="destructive"
                  label={`Xác nhận chặn ${name}`}
                  isLoading={isBusy}
                  isDisabled={isBusy}
                  onClick={() => confirm(request, "block")}
                >
                  Chặn hẳn
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  label={`Không chặn ${name}`}
                  isDisabled={isBusy}
                  onClick={() => setPending(null)}
                >
                  Giữ nguyên
                </Button>
              </HStack>
            </Stack>
          );
        }

        // --- Step 1: what this row can still be turned into ------------------
        // A decided row keeps the OPPOSITE action: an approved account has to be
        // blockable the day someone leaves, and a blocked one un-blockable when
        // it was a mistake. Re-deciding is not part of the written contract, so
        // the failure path is the server's answer, shown as-is.
        // PENDING(access-redecide): confirm the API accepts a decision on a row
        // that already has one; if it refuses, these buttons come off.
        return (
          <HStack gap={2} align="center" wrap="wrap">
            {request.status !== "approved" ? (
              <Button
                size="sm"
                variant="primary"
                label={`Duyệt ${name}`}
                isLoading={isBusy}
                isDisabled={isBusy}
                onClick={() => ask(request.id, "approve")}
              >
                Duyệt
              </Button>
            ) : null}
            {request.status !== "blocked" ? (
              <Button
                size="sm"
                variant="ghost"
                label={`Chặn ${name}`}
                isDisabled={isBusy}
                onClick={() => ask(request.id, "block")}
              >
                Chặn
              </Button>
            ) : null}
          </HStack>
        );
      },
    },
  ];

  return (
    <Stack direction="vertical" isScrollable height="100%">
      <Table
        data={items as AccessRequestRow[]}
        columns={columns}
        idKey="id"
        density="compact"
        hasHover
        verticalAlign="top"
        textOverflow="truncate"
        rowCount={items.length}
      />
    </Stack>
  );
}
