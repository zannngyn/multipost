import { Skeleton, Stack } from "@astryxdesign/core";

/**
 * What the page shows while `useSearchParams()` suspends (the screen reads the
 * step from the query string). Same blocks and heights as the real screen —
 * title, step rail, step body — so nothing jumps when it resolves (CLS = 0).
 *
 * `aria-hidden`: a screen reader has nothing to read in a grey box
 * (web-feedback-states rule 4).
 */
export function DataMappingFallback() {
  return (
    <Stack direction="vertical" gap={5} padding={4} maxWidth={960} aria-hidden="true">
      <Stack direction="vertical" gap={1}>
        <Skeleton height={32} width={220} />
        <Skeleton height={20} width="60%" />
      </Stack>
      <Skeleton height={168} />
      <Skeleton height={260} />
    </Stack>
  );
}
