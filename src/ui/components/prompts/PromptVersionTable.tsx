"use client";

import {
  Badge,
  Button,
  Card,
  HStack,
  Heading,
  Stack,
  Table,
  Text,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import { useEffect, useId, useRef, useState } from "react";

import {
  PROMPT_STATUS_BADGE_VARIANTS,
  describePromptVersions,
  type PromptVersionDescriptor,
} from "@/ui/components/prompts/prompt-version-label";
import { PROMPT_STATUS_LABELS, type PromptVersion } from "@/ui/schemas/prompt.schema";

/**
 * Version table of the prompt catalog (E10.7).
 *
 * Three things it must make obvious:
 *  1. WHICH version is active — exactly one row, badge "Đang dùng";
 *  2. which row is the BUILT-IN template — read-only, cannot be activated by
 *     hand and cannot be deleted, because it is shipped in code;
 *  3. WHICH ROW IS WHICH when two of them carry the same number — the version
 *     counter is not unique across sources, so every row also names its origin
 *     and its moment (`prompt-version-label.ts`).
 *
 * The full text of a version opens in ONE detail panel under the table rather
 * than inside a cell: a prompt body is a dozen wrapped lines and a column is the
 * wrong shape for it. The panel is `aria-controls` of whichever row opened it,
 * so a screen-reader user is told where the content went.
 *
 * Activating an old version is a two-step confirmation (core-bulk-actions
 * §Xác nhận, level 1): it silently changes every caption generated afterwards,
 * so a stray click must not do it.
 *
 * Presentational: fetching and mutations live in the screen above.
 */

/** Astryx `Table` needs an index signature; the payload stays a descriptor. */
type VersionRow = PromptVersionDescriptor & Record<string, unknown>;

export function PromptVersionTable({
  versions,
  activatingVersion,
  disabled,
  readOnlyReason,
  onActivate,
  onReuse,
}: {
  versions: readonly PromptVersion[];
  /** Version currently being activated, so only its button shows the pending state. */
  activatingVersion: number | null;
  disabled?: boolean;
  /**
   * Why writing is off (support mode, M3.3). Every write control in a row is
   * blocked by `disabled` and explains itself with this sentence — "Dùng làm
   * bản nháp" opens the create form, so it is a write control too.
   */
  readOnlyReason?: string | null;
  onActivate: (version: number) => void;
  /** Prefills the "tạo phiên bản mới" form from this row. */
  onReuse: (version: PromptVersion) => void;
}) {
  const detailId = useId();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  /** Row toggles, so closing the detail panel can hand focus back to its opener. */
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());

  const rows = describePromptVersions(versions) as readonly VersionRow[];
  const open = rows.find((row) => row.key === openKey) ?? null;

  /** The opener stays mounted, so focus can move back in the same tick. */
  function closeDetail() {
    const previous = openKey;
    setOpenKey(null);
    if (previous) toggleRefs.current.get(previous)?.focus();
  }

  const columns: TableColumn<VersionRow>[] = [
    {
      key: "version",
      header: "Phiên bản",
      width: pixel(150),
      renderCell: (row) => (
        <Stack direction="vertical" gap={0.5}>
          <Text weight="semibold" hasTabularNumbers>
            {row.label.number}
          </Text>
          {row.label.origin ? (
            <Text type="supporting" color="secondary">
              {row.label.origin}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "name",
      header: "Tên",
      width: proportional(1),
      renderCell: (row) => <Text>{row.item.name}</Text>,
    },
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(190),
      renderCell: (row) => (
        <Stack direction="vertical" gap={0.5} align="start">
          <Badge
            variant={PROMPT_STATUS_BADGE_VARIANTS[row.item.status]}
            label={PROMPT_STATUS_LABELS[row.item.status]}
          />
          {/* The Named Status Rule: the pill never carries the fact alone. */}
          {row.label.supersededNote ? (
            <Text type="supporting" color="secondary">
              {row.label.supersededNote}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "changelog",
      header: "Vì sao đổi",
      width: proportional(1),
      renderCell: (row) =>
        row.item.changelog.trim() ? (
          <Text color="secondary">{row.item.changelog}</Text>
        ) : (
          <Text color="placeholder">Không ghi lý do</Text>
        ),
    },
    {
      key: "createdAt",
      header: "Tạo lúc",
      width: pixel(190),
      renderCell: (row) => (
        <Stack direction="vertical" gap={0.5}>
          <Text color="secondary" hasTabularNumbers>
            {row.label.stamp}
          </Text>
          {row.item.createdBy ? (
            <Text type="supporting" color="secondary" wordBreak="break-all">
              {row.item.createdBy}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(320),
      renderCell: (row) => (
        <RowActions
          row={row}
          detailId={detailId}
          isOpen={openKey === row.key}
          isConfirming={confirmKey === row.key}
          disabled={disabled}
          readOnlyReason={readOnlyReason}
          activatingVersion={activatingVersion}
          registerToggleRef={(node) => {
            if (node) toggleRefs.current.set(row.key, node);
            else toggleRefs.current.delete(row.key);
          }}
          onToggleDetail={() => (openKey === row.key ? closeDetail() : setOpenKey(row.key))}
          onStartConfirm={() => setConfirmKey(row.key)}
          onCancelConfirm={() => setConfirmKey(null)}
          onActivate={() => {
            setConfirmKey(null);
            onActivate(row.item.version);
          }}
          onReuse={() => onReuse(row.item)}
        />
      ),
    },
  ];

  return (
    <Stack direction="vertical" gap={3}>
      <Table
        data={rows as VersionRow[]}
        columns={columns}
        idKey="key"
        density="compact"
        hasHover
        verticalAlign="top"
        rowCount={rows.length}
      />

      {open ? <PromptBodyPanel id={detailId} descriptor={open} onClose={closeDetail} /> : null}
    </Stack>
  );
}

function RowActions({
  row,
  detailId,
  isOpen,
  isConfirming,
  disabled,
  readOnlyReason,
  activatingVersion,
  registerToggleRef,
  onToggleDetail,
  onStartConfirm,
  onCancelConfirm,
  onActivate,
  onReuse,
}: {
  row: VersionRow;
  detailId: string;
  isOpen: boolean;
  isConfirming: boolean;
  disabled?: boolean;
  readOnlyReason?: string | null;
  activatingVersion: number | null;
  registerToggleRef: (node: HTMLButtonElement | null) => void;
  onToggleDetail: () => void;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
  onActivate: () => void;
  onReuse: () => void;
}) {
  const isBuiltIn = row.item.source === "built_in";
  const isBusy = activatingVersion !== null;

  const confirmRef = useRef<HTMLButtonElement>(null);
  const activateRef = useRef<HTMLButtonElement>(null);
  /**
   * Set by "Không" so focus can follow "Kích hoạt" back when it remounts. A ref
   * rather than state: this is a one-shot instruction to the DOM, and holding it
   * in state would schedule a render just to clear it again.
   */
  const restoreActivateFocus = useRef(false);

  // Each side of the confirmation replaces the button that was just pressed, so
  // focus travels with it — otherwise the keyboard lands on <body> mid-decision.
  useEffect(() => {
    if (isConfirming) {
      confirmRef.current?.focus();
      return;
    }
    if (!restoreActivateFocus.current) return;
    restoreActivateFocus.current = false;
    activateRef.current?.focus();
  }, [isConfirming]);

  // Two rows can share a number, so every accessible name carries the origin
  // too — otherwise a screen reader announces "Xem nội dung v2" twice.
  const rowName = row.label.origin ? `${row.label.number} — ${row.label.origin}` : row.label.number;
  const writeBlockReason = disabled ? (readOnlyReason ?? undefined) : undefined;

  return (
    <Stack direction="vertical" gap={2} align="start">
      <HStack gap={2} wrap="wrap" align="center">
        <Button
          ref={registerToggleRef}
          size="sm"
          variant="secondary"
          label={isOpen ? `Ẩn nội dung ${rowName}` : `Xem nội dung ${rowName}`}
          aria-expanded={isOpen}
          // Only while the panel exists: an IDREF to an unmounted node is a
          // dead pointer for assistive tech.
          aria-controls={isOpen ? detailId : undefined}
          onClick={onToggleDetail}
        >
          {isOpen ? "Ẩn nội dung" : "Xem nội dung"}
        </Button>

        {row.item.body ? (
          // A write control: it opens the create form, so the read-only gate
          // (M3.3) has to stop it here as well as at the section trigger.
          <Button
            size="sm"
            variant="ghost"
            label={`Dùng làm bản nháp — ${rowName}`}
            isDisabled={disabled}
            tooltip={writeBlockReason}
            onClick={onReuse}
          >
            Dùng làm bản nháp
          </Button>
        ) : null}

        {!isBuiltIn && row.item.status !== "active" && !isConfirming ? (
          <Button
            ref={activateRef}
            size="sm"
            variant="secondary"
            label={`Kích hoạt ${rowName}`}
            isDisabled={disabled || isBusy}
            tooltip={writeBlockReason}
            onClick={onStartConfirm}
          >
            Kích hoạt
          </Button>
        ) : null}
      </HStack>

      {isBuiltIn ? (
        <Text type="supporting" color="secondary">
          Đi kèm phần mềm — không bật tay được.
        </Text>
      ) : null}

      {isConfirming ? (
        <Stack direction="vertical" gap={2} align="start">
          <Text type="supporting" role="alert">
            Kích hoạt {rowName}? Mọi caption sinh sau đó dùng bản này; caption đã sinh không đổi.
          </Text>
          <HStack gap={2} wrap="wrap" align="center">
            <Button
              ref={confirmRef}
              size="sm"
              variant="primary"
              label={`Xác nhận kích hoạt ${rowName}`}
              isLoading={activatingVersion === row.item.version}
              isDisabled={disabled || activatingVersion !== null}
              onClick={onActivate}
            >
              Xác nhận
            </Button>
            {/* Accessible name contains the visible text (WCAG 2.5.3). */}
            <Button
              size="sm"
              variant="ghost"
              label="Không đổi bản đang dùng"
              onClick={() => {
                restoreActivateFocus.current = true;
                onCancelConfirm();
              }}
            >
              Không
            </Button>
          </HStack>
        </Stack>
      ) : null}
    </Stack>
  );
}

/**
 * The exact text of one version. Read-only on purpose: prompt rows are
 * immutable, so "sửa" means "dùng làm bản nháp" then save a new version.
 */
function PromptBodyPanel({
  id,
  descriptor,
  onClose,
}: {
  id: string;
  descriptor: PromptVersionDescriptor;
  onClose: () => void;
}) {
  const headingId = `${id}-heading`;
  const { item, label } = descriptor;

  return (
    <Card padding={4} aria-labelledby={headingId}>
      <Stack direction="vertical" gap={3}>
        <HStack gap={3} justify="between" align="start" wrap="wrap">
          <Stack direction="vertical" gap={0.5}>
            <Heading level={3} id={headingId}>
              Nội dung {label.number} — {item.name}
            </Heading>
            <Text type="supporting" color="secondary">
              {label.origin ? `${label.origin} · ` : ""}
              {label.stamp}
            </Text>
          </Stack>
          <Button size="sm" variant="ghost" label="Đóng nội dung phiên bản" onClick={onClose}>
            Đóng
          </Button>
        </HStack>

        <Stack direction="vertical" gap={1}>
          <Text type="label">System prompt</Text>
          <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {item.systemPrompt ?? "(không có sẵn nội dung cho phiên bản này)"}
          </pre>
        </Stack>

        <Stack direction="vertical" gap={1}>
          <Text type="label">Nội dung prompt</Text>
          <pre className="bg-muted/40 max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {item.body ?? "(không có sẵn nội dung cho phiên bản này)"}
          </pre>
        </Stack>

        <Text type="supporting" color="secondary">
          Biến dùng trong bản này:{" "}
          {item.variables.length > 0 ? item.variables.join(", ") : "(không có)"}.
        </Text>
      </Stack>
    </Card>
  );
}
