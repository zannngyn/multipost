"use client";

import { HStack, Skeleton, Stack, StackItem } from "@astryxdesign/core";

/** Column widths mirror JobLogTable so the real rows land where these sat. */
const COLUMNS = [170, 150, 140, 110, 150, 90, null, 170] as const;
const ROWS = 5;

/**
 * Skeleton with the SAME eight columns and row height as `JobLogTable`
 * (web-data-table rule 1: a mismatched skeleton is a layout shift).
 *
 * `aria-hidden`: a screen reader has nothing to gain from forty grey boxes; the
 * screen announces "đang tải" in its own live region.
 */
export function JobLogSkeleton() {
  return (
    <Stack direction="vertical" gap={0} aria-hidden="true">
      {Array.from({ length: ROWS }, (_unused, row) => (
        <HStack key={row} gap={3} paddingInline={4} paddingBlock={3} align="start">
          {COLUMNS.map((width, column) =>
            width === null ? (
              // The "Lý do / kết quả" column: two lines, because that is what a
              // real reason takes and the row height has to match it.
              <StackItem key={column} size="fill">
                <Stack direction="vertical" gap={1.5}>
                  <Skeleton width="100%" height={14} index={row} />
                  <Skeleton width="60%" height={14} index={row} />
                </Stack>
              </StackItem>
            ) : (
              <Skeleton key={column} width={width} height={14} index={row} />
            ),
          )}
        </HStack>
      ))}
    </Stack>
  );
}
