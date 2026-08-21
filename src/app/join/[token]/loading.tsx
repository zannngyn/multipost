import { Card, Skeleton, Stack, Text } from "@astryxdesign/core";

/**
 * Route-level loading state for `/join/<token>`.
 *
 * `JoinInviteScreen` already owns the pending state of the redemption call, but
 * that state only exists once the client bundle is running. Before it, the page
 * is awaiting `getOperatorSession` on the server — a real wait, on a route
 * people reach by clicking a link in a chat window, on whatever network they
 * happen to be on. This file covers that first gap so the panel is on screen
 * from the start and only its text arrives late.
 *
 * Same frame as the page: one centred Card at 560px. The two bars stand in for
 * the heading and the status line the screen renders while it redeems the
 * token, so the panel does not resize when the real content lands.
 */
export default function JoinLoading() {
  return (
    <main className="flex w-full flex-1">
      <Stack direction="vertical" vAlign="center" width="100%" padding={6}>
        <Card padding={6} width="100%" maxWidth={560} className="mx-auto">
          <Stack direction="vertical" gap={3}>
            <Text type="supporting" role="status" aria-live="polite">
              Đang mở lời mời, vui lòng đợi.
            </Text>
            <Stack direction="vertical" gap={2} aria-hidden="true">
              <Skeleton width="60%" height={28} />
              <Skeleton width="100%" height={16} index={1} />
              <Skeleton width="70%" height={16} index={2} />
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </main>
  );
}
