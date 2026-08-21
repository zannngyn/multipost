"use client";

import { HStack, Section, Skeleton, Stack } from "@astryxdesign/core";

/** Column widths mirror AccessRequestTable so the real rows land where these sat. */
const COLUMNS = [140, null, 140, 170, 130, 170, null, 420] as const;
const ROWS = 5;

/**
 * Loading placeholder for the access requests. Shaped like the real table —
 * same column widths, same row height, and a header strip where the real
 * header sits — so nothing jumps when the data lands (web-feedback-states §1:
 * a skeleton that does not match is worse than none).
 */
export function AccessRequestTableSkeleton() {
  return (
    <Stack direction="vertical" gap={0} padding={0} aria-hidden="true">
      <Section variant="muted" padding={0} dividers={["bottom"]}>
        <HStack gap={3} paddingInline={3} paddingBlock={2} align="center">
          {COLUMNS.map((width, column) => (
            <Skeleton key={column} width={width ?? "100%"} height={12} />
          ))}
        </HStack>
      </Section>

      {Array.from({ length: ROWS }, (_, row) => (
        <HStack key={row} gap={3} padding={3} align="center">
          {COLUMNS.map((width, column) => (
            <Skeleton key={column} width={width ?? "100%"} height={16} index={row} />
          ))}
        </HStack>
      ))}
    </Stack>
  );
}
