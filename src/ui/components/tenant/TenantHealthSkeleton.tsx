import { HStack, Skeleton, Stack } from "@astryxdesign/core";

/**
 * Loading placeholder for TenantHealthCard. Every block mirrors a real one — the
 * status dot, the name, then three label/value rows — so nothing moves when the
 * data lands (web-feedback-states rule 1: CLS = 0).
 *
 * `aria-hidden` because a screen reader has nothing to gain from grey boxes —
 * the live region next to it announces "đang kiểm tra".
 */
export function TenantHealthSkeleton() {
  return (
    <Stack direction="vertical" gap={4} aria-hidden="true">
      <HStack gap={2} align="center">
        <Skeleton width={8} height={8} radius="rounded" />
        <Skeleton width={180} height={20} />
        <Skeleton width={112} height={16} index={1} />
      </HStack>

      <Stack direction="vertical" gap={2}>
        {SKELETON_VALUE_WIDTHS.map((valueWidth, row) => (
          <HStack key={valueWidth} gap={3} align="center">
            {/* Same 144px label column as the real MetadataList. */}
            <Skeleton width={144} height={16} index={row} />
            <Skeleton width={valueWidth} height={16} index={row} />
          </HStack>
        ))}
      </Stack>
    </Stack>
  );
}

/** One entry per row of the real card, at roughly its real value length. */
const SKELETON_VALUE_WIDTHS = [232, 148, 300] as const;
