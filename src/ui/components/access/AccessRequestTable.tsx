"use client";

import { HStack, Stack, StatusDot, Table, Text, Token, pixel, proportional } from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";

import {
  ACCESS_PROVIDER_LABELS,
  ACCESS_PROVIDER_TONES,
  ACCESS_REQUEST_STATUS_LABELS,
  ACCESS_REQUEST_STATUS_TONES,
  ACCESS_ROLE_LABELS,
  accessRequestDisplayName,
  accessRequestEmailLabel,
  hasEmail,
  type AccessRequest,
} from "@/ui/schemas/access-request.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * Access requests as rows, READ-ONLY since M2.4.
 *
 * The approval queue is retired: people are added with an invite link on the
 * "Thành viên" screen. This table is kept as the HISTORY of who asked, who
 * decided and when — deleting it would delete the audit trail of every account
 * that was ever let in or refused.
 *
 * The action column is gone rather than disabled: there is nothing here an
 * admin could do, and a row of dead buttons is worse than no buttons
 * (core-auth-session — hide what cannot be acted on, explain it once at the top
 * of the screen instead).
 *
 * Status is a StatusDot plus its label in text — never colour alone
 * (core-accessibility §5).
 */

/** Table's generic needs an index signature; the fields stay AccessRequest's. */
type AccessRequestRow = AccessRequest & Record<string, unknown>;

export function AccessRequestTable({ items }: { items: readonly AccessRequest[] }) {
  const columns: TableColumn<AccessRequestRow>[] = [
    {
      key: "status",
      header: "Kết quả",
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
          <Text weight="medium">{accessRequestDisplayName(request)}</Text>
          {/* A provider that sent no e-mail is a fact, not a blank cell — and
              never the string "null". */}
          {hasEmail(request.email) ? (
            <Text type="supporting" maxLines={1}>
              {accessRequestEmailLabel(request.email)}
            </Text>
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
        // The provider is a category, not a state — a token, so the row's one
        // badge-weight element stays the thing that decides: its status.
        <Token
          size="sm"
          color={ACCESS_PROVIDER_TONES[request.provider]}
          label={ACCESS_PROVIDER_LABELS[request.provider]}
        />
      ),
    },
    {
      key: "providerAccountId",
      header: "Mã tài khoản",
      width: pixel(170),
      renderCell: (request) => (
        <Text color="secondary" hasTabularNumbers maxLines={1}>
          {request.providerAccountId}
        </Text>
      ),
    },
    {
      key: "role",
      header: "Vai trò đã cấp",
      width: pixel(140),
      renderCell: (request) =>
        request.role === null ? (
          <Text color="placeholder">Không có</Text>
        ) : (
          <Text>{ACCESS_ROLE_LABELS[request.role]}</Text>
        ),
    },
    {
      key: "requestedAt",
      header: "Lúc yêu cầu",
      width: pixel(170),
      renderCell: (request) => (
        <Text color="secondary" hasTabularNumbers>
          {formatDateTime(request.requestedAt)}
        </Text>
      ),
    },
    {
      key: "decidedAt",
      header: "Ai quyết định",
      width: proportional(1),
      renderCell: (request) =>
        request.decidedAt === null && request.decidedByEmail === null ? (
          // Left over from the retired queue: nobody ever acted on this one.
          <Text color="placeholder">Không ai quyết định</Text>
        ) : (
          <Stack direction="vertical" gap={0.5}>
            <Text type="supporting" maxLines={1}>
              {request.decidedByEmail ?? "Không rõ người quyết định"}
            </Text>
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {formatDateTime(request.decidedAt)}
            </Text>
          </Stack>
        ),
    },
  ];

  return (
    <Stack direction="vertical" isScrollable height="100%">
      <Table
        aria-label="Lịch sử yêu cầu truy cập"
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
