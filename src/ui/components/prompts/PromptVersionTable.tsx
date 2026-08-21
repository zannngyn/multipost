"use client";

import {
  Button,
  CodeBlock,
  HStack,
  Heading,
  Section,
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

import {
  PROMPT_STATUS_LABELS,
  formatPromptDate,
  type PromptStatus,
  type PromptVersion,
} from "@/ui/schemas/prompt.schema";

/**
 * Version table of the prompt catalog (E10.7).
 *
 * Three things it must make obvious:
 *  1. WHICH version is active — exactly one row, a green dot and the words
 *     "Đang dùng";
 *  2. which row is the BUILT-IN template — read-only, cannot be activated by
 *     hand and cannot be deleted, because it is shipped in code;
 *  3. what each version changed (changelog) and what its body actually says.
 *
 * Activating an old version is a two-step confirmation (core-bulk-actions
 * §Xác nhận, level 1): it silently changes every caption generated afterwards,
 * so a stray click must not do it.
 *
 * The text of a version opens in a panel DIRECTLY BELOW the table rather than
 * inside the row: a prompt body is dozens of lines, and a row that grows that
 * tall pushes every other version off the screen. `aria-controls` on the
 * trigger keeps the two connected for assistive tech.
 *
 * Presentational: fetching and mutations live in the screen above.
 */

/** Table's generic needs an index signature; the fields stay PromptVersion's. */
type PromptVersionRow = PromptVersion & Record<string, unknown>;

/**
 * Status is a state, so it reads as a dot plus its label — never colour alone
 * (core-accessibility §5). `PROMPT_STATUS_TONES` speaks the local badge's
 * vocabulary, which has no StatusDot equivalent for "info".
 */
const PROMPT_STATUS_DOTS: Record<PromptStatus, "success" | "accent" | "neutral"> = {
  active: "success",
  draft: "accent",
  retired: "neutral",
};

export function PromptVersionTable({
  versions,
  activatingVersion,
  disabled,
  onActivate,
  onReuse,
}: {
  versions: readonly PromptVersion[];
  /** Version currently being activated, so only its button shows the pending state. */
  activatingVersion: number | null;
  disabled?: boolean;
  onActivate: (version: number) => void;
  /** Prefills the "tạo phiên bản mới" form from this row. */
  onReuse: (version: PromptVersion) => void;
}) {
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);

  const opened = versions.find((version) => version.version === openVersion) ?? null;

  const columns: TableColumn<PromptVersionRow>[] = [
    {
      key: "version",
      header: "Phiên bản",
      width: pixel(90),
      renderCell: (version) => (
        <Text weight="medium" hasTabularNumbers>
          v{version.version}
        </Text>
      ),
    },
    {
      key: "name",
      header: "Tên",
      width: proportional(2),
      renderCell: (version) => (
        <Stack direction="vertical" gap={0.5}>
          <Text>{version.name}</Text>
          {version.source === "built_in" ? (
            <HStack>
              <Token size="sm" color="gray" label="Mặc định hệ thống" />
            </HStack>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(140),
      renderCell: (version) => (
        <HStack gap={2} align="center">
          <StatusDot
            variant={PROMPT_STATUS_DOTS[version.status]}
            label={PROMPT_STATUS_LABELS[version.status]}
          />
          <Text color={version.status === "active" ? "primary" : "secondary"}>
            {PROMPT_STATUS_LABELS[version.status]}
          </Text>
        </HStack>
      ),
    },
    {
      key: "changelog",
      header: "Vì sao đổi",
      width: proportional(3),
      renderCell: (version) =>
        version.changelog.trim() ? (
          // Two lines with a tooltip: a long reason must not make one row four
          // times taller than the rest of the list.
          <Text maxLines={2}>{version.changelog}</Text>
        ) : (
          <Text color="placeholder">Không ghi lý do</Text>
        ),
    },
    {
      key: "createdAt",
      header: "Tạo lúc",
      width: pixel(160),
      renderCell: (version) => (
        <Stack direction="vertical" gap={0.5}>
          <Text color="secondary" hasTabularNumbers>
            {formatPromptDate(version.createdAt)}
          </Text>
          {version.createdBy ? (
            <Text type="supporting" maxLines={1}>
              {version.createdBy}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(340),
      renderCell: (version) => {
        const isOpen = openVersion === version.version;
        const isConfirming = confirmVersion === version.version;
        const isBuiltIn = version.source === "built_in";

        // --- Step 2: activating an old version, spelled out -----------------
        if (isConfirming) {
          return (
            <Stack direction="vertical" gap={2}>
              <Text type="supporting" color="primary" role="alert">
                Kích hoạt v{version.version}? Mọi caption sinh sau đó dùng bản này; caption đã sinh
                giữ nguyên.
              </Text>
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  variant="primary"
                  label={`Xác nhận kích hoạt phiên bản v${version.version}`}
                  isDisabled={disabled || activatingVersion !== null}
                  onClick={() => {
                    setConfirmVersion(null);
                    onActivate(version.version);
                  }}
                >
                  {activatingVersion === version.version ? "Đang bật…" : "Xác nhận"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  label={`Không kích hoạt phiên bản v${version.version}`}
                  onClick={() => setConfirmVersion(null)}
                >
                  Giữ nguyên
                </Button>
              </HStack>
            </Stack>
          );
        }

        return (
          <HStack gap={2} align="center" wrap="wrap">
            <Button
              size="sm"
              variant="secondary"
              label={`${isOpen ? "Ẩn" : "Xem"} nội dung phiên bản v${version.version}`}
              aria-expanded={isOpen}
              // Only while the panel exists: a dangling `aria-controls` points
              // assistive tech at nothing.
              aria-controls={isOpen ? "prompt-version-body" : undefined}
              onClick={() => setOpenVersion(isOpen ? null : version.version)}
            >
              {isOpen ? "Ẩn nội dung" : "Xem nội dung"}
            </Button>

            {version.body ? (
              <Button
                size="sm"
                variant="ghost"
                label={`Dùng nội dung v${version.version} làm bản nháp`}
                onClick={() => onReuse(version)}
              >
                Dùng làm bản nháp
              </Button>
            ) : null}

            {!isBuiltIn && version.status !== "active" ? (
              <Button
                size="sm"
                variant="ghost"
                label={`Kích hoạt phiên bản v${version.version}`}
                isDisabled={disabled || activatingVersion !== null}
                onClick={() => setConfirmVersion(version.version)}
              >
                Kích hoạt
              </Button>
            ) : null}
          </HStack>
        );
      },
    },
  ];

  return (
    <Stack direction="vertical" gap={0}>
      <Stack direction="vertical" isScrollable>
        <Table
          aria-label="Các phiên bản prompt của tác vụ viết caption Facebook, mới nhất trước"
          data={versions as PromptVersionRow[]}
          columns={columns}
          idKey={(version) => `${version.source}-${version.version}`}
          density="compact"
          hasHover
          verticalAlign="top"
          textOverflow="truncate"
          rowCount={versions.length}
        />
      </Stack>

      {/* One panel for the whole table, directly after the rows: it exists
          only while a version is open, which is exactly when a trigger points
          at it. */}
      {opened ? (
        <Section id="prompt-version-body" variant="muted" padding={4} dividers={["top"]}>
          <Stack direction="vertical" gap={3}>
            <HStack gap={3} justify="between" align="center" wrap="wrap">
              <Heading level={4}>
                Nội dung phiên bản v{opened.version}: {opened.name}
              </Heading>
              <Button
                size="sm"
                variant="ghost"
                label={`Đóng nội dung phiên bản v${opened.version}`}
                onClick={() => setOpenVersion(null)}
              >
                Đóng
              </Button>
            </HStack>

            <Stack direction="vertical" gap={1}>
              <Text type="label">System prompt</Text>
              <CodeBlock
                code={opened.systemPrompt ?? "(không có sẵn nội dung cho phiên bản này)"}
                language="plaintext"
                isWrapped
                width="100%"
                maxHeight={240}
                container="card"
              />
            </Stack>

            <Stack direction="vertical" gap={1}>
              <Text type="label">Nội dung prompt</Text>
              <CodeBlock
                code={opened.body ?? "(không có sẵn nội dung cho phiên bản này)"}
                language="plaintext"
                isWrapped
                width="100%"
                maxHeight={420}
                container="card"
              />
            </Stack>

            <Text type="supporting">
              Biến dùng trong bản này:{" "}
              {opened.variables.length > 0 ? opened.variables.join(", ") : "(không có)"}.
            </Text>
          </Stack>
        </Section>
      ) : null}
    </Stack>
  );
}
