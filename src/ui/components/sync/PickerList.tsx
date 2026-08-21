"use client";

import { HStack, List, ListItem, Skeleton, Stack, Text } from "@astryxdesign/core";

/**
 * The list every step of `GoogleDrivePicker` is made of: folders, spreadsheets,
 * sheet tabs. One component, three uses (core-component-reuse) — the rows only
 * differ in what they say, not in how they behave.
 *
 * Keyboard: rows are the design system's own list items, so the focus ring,
 * Enter/Space and the announced selected state come from the platform and from
 * Astryx rather than from a hand-rolled composite widget.
 *
 * TRADE-OFF, on purpose: the previous version made the whole list ONE tab stop
 * with arrow-key roving. Astryx `ListItem` owns its own interactive element, so
 * roving cannot be layered on top of it without re-implementing the row — and a
 * half-built composite widget is worse than a plain list (core-data-table §Bàn
 * phím). The mitigation is the one that was already there: every step has a
 * search field directly above the list, and the list is paged rather than
 * endless.
 */

export interface PickerRow {
  /** Stable identity — the Drive id, or the tab name for step 3. */
  key: string;
  label: string;
  /** Secondary line, e.g. a shortened id. */
  hint?: string;
  isSelected?: boolean;
}

export function PickerList({
  ariaLabel,
  rows,
  onSelect,
  isBusy = false,
}: {
  ariaLabel: string;
  rows: readonly PickerRow[];
  onSelect: (key: string) => void;
  /** A background page load: rows stay usable, they just look muted. */
  isBusy?: boolean;
}) {
  // Region budget (`astryx docs layout`): past ~7 rows the list gets its own
  // scroll so the step's buttons stay on screen. A short list keeps its natural
  // height — a fixed 288px box around three folders reads as a broken viewport.
  const isLong = rows.length > 7;

  return (
    <Stack
      direction="vertical"
      isScrollable={isLong}
      height={isLong ? 288 : undefined}
      aria-busy={isBusy || undefined}
    >
      <List density="compact" hasDividers aria-label={ariaLabel}>
        {rows.map((row) => (
          <ListItem
            key={row.key}
            label={row.label}
            isSelected={row.isSelected}
            onClick={() => onSelect(row.key)}
            endContent={
              row.hint ? (
                <Text type="code" size="2xs" color="secondary">
                  {row.hint}
                </Text>
              ) : undefined
            }
          />
        ))}
      </List>
    </Stack>
  );
}

/**
 * Same box, same row height as the real list, so nothing jumps when the page
 * lands (web-feedback-states rule 1: CLS = 0). `aria-hidden` because a screen
 * reader gains nothing from grey boxes — the picker's live region says "đang
 * tải".
 */
export function PickerListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Stack direction="vertical" gap={0} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <HStack key={index} gap={3} paddingInline={3} paddingBlock={2} align="center">
          <Skeleton width={192} height={16} index={index} />
          <Skeleton width={64} height={12} index={index} />
        </HStack>
      ))}
    </Stack>
  );
}
