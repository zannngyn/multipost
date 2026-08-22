"use client";

import { Banner, Button, EmptyState, Heading, HStack, Stack, StackItem, Text } from "@astryxdesign/core";

import { ChannelTable } from "@/ui/components/channels/ChannelTable";
import { ChannelTableSkeleton } from "@/ui/components/channels/ChannelTableSkeleton";
import { secretsNotConfiguredReason } from "@/ui/components/channels/channel-secrets";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { presentApiError, toApiError } from "@/ui/components/feedback/present-api-error";
import { useChannels, useRemoveChannel, useSetChannelStatus } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import type { Channel, ChannelStatus } from "@/ui/schemas/channel.schema";

/**
 * "Page đã kết nối" (E5.1) — the Fanpages this tenant may publish to, and the
 * screen that has to exist before a channel group can contain anything real.
 *
 * Since the wave-1 IA this is a PANEL of the "Kênh" hub, not a page: the hub
 * above owns the frame, the h1, the OAuth callback banner, the secrets warning
 * and the connect form (which is now its own tab). What is left here is one
 * list and its states — the reason the split was worth doing.
 *
 * The four mandatory states live in `ChannelListBody`:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — one row per Page, each with bật/tắt and gỡ
 *   empty   — the important one: explains what to do and sends the operator to
 *             the "Kết nối thêm" tab
 *   error   — via `presentApiError` (4xx: sửa dữ liệu; 5xx: thử lại)
 */
export function ConnectedChannelsScreen({
  areWritesBlocked,
  blockedReasonOverride,
  onGoToConnect,
}: {
  /**
   * Derived once by the hub from the same two facts both tabs need: the server
   * cannot seal credentials (M3.3 secrets), or this is a support session.
   */
  areWritesBlocked: boolean;
  /** The sentence to show when the block is not the missing key (M3.3). */
  blockedReasonOverride?: string;
  /** Takes the operator to the tab that can actually add a Page. */
  onGoToConnect: () => void;
}) {
  const channels = useChannels();
  const setStatus = useSetChannelStatus();
  const remove = useRemoveChannel();

  const items = channels.data?.channels ?? [];
  const isFirstLoad = channels.isPending && channels.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const busyChannelId = setStatus.isPending
    ? (setStatus.variables?.channelId ?? null)
    : remove.isPending
      ? (remove.variables?.channelId ?? null)
      : null;

  return (
    <Stack direction="vertical" height="100%">
      <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
        {/* h2: the hub above owns the page's h1 (core-accessibility §1). */}
        <Heading level={2}>Page đã kết nối</Heading>
        {/* Only once the list is real: "0 Page" while loading reads as an
            answer, and the operator would act on it. */}
        {channels.data ? (
          <Text type="supporting" role="status" aria-live="polite">
            {items.length} Page
          </Text>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          label={channels.isFetching ? "Đang tải…" : "Tải lại"}
          isDisabled={channels.isFetching}
          onClick={() => void channels.refetch()}
        />
      </HStack>

      {setStatus.isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={0}>
          <ApiErrorNotice error={setStatus.error} />
        </Stack>
      ) : null}
      {remove.isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={0}>
          <ApiErrorNotice error={remove.error} />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <ChannelListBody
          isFirstLoad={isFirstLoad}
          showSkeleton={showSkeleton}
          isError={channels.isError}
          error={channels.error}
          onRetry={() => void channels.refetch()}
          items={items}
          busyChannelId={busyChannelId}
          areWritesBlocked={areWritesBlocked}
          blockedReasonOverride={blockedReasonOverride}
          onGoToConnect={onGoToConnect}
          onSetStatus={(channelId, status) => {
            setStatus.reset();
            remove.reset();
            setStatus.mutate({ channelId, status });
          }}
          onRemove={(channelId) => {
            setStatus.reset();
            remove.reset();
            remove.mutate({ channelId });
          }}
        />
      </StackItem>
    </Stack>
  );
}

function ChannelListBody({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  items,
  busyChannelId,
  areWritesBlocked,
  blockedReasonOverride,
  onGoToConnect,
  onSetStatus,
  onRemove,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  items: readonly Channel[];
  busyChannelId: string | null;
  areWritesBlocked: boolean;
  /** Set when writes are off for a reason OTHER than the missing key (M3.3). */
  blockedReasonOverride?: string;
  onGoToConnect: () => void;
  onSetStatus: (channelId: string, status: ChannelStatus) => void;
  onRemove: (channelId: string) => void;
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <ChannelTableSkeleton /> : null;

  // --- Error, with nothing to fall back on ---------------------------------
  if (isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={error} onRetry={onRetry} />
      </Stack>
    );
  }

  // --- Empty: the whole point of this screen for a new tenant ---------------
  if (items.length === 0) {
    // Sending someone to a form that cannot save would contradict the banner
    // above. Same empty list, different next step.
    //
    // In support mode the sentence is different again: nothing is broken, the
    // company simply has no Page and MYSP staff are not the ones to add it.
    if (blockedReasonOverride) {
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            headingLevel={3}
            title="Công ty này chưa kết nối Fanpage nào"
            description={`Chưa có Page nào để đăng bài. ${blockedReasonOverride}`}
          />
        </Stack>
      );
    }

    if (areWritesBlocked) {
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            headingLevel={3}
            title="Chưa kết nối Fanpage nào"
            description={`Chưa thể kết nối Page cho tới khi máy chủ được cấu hình xong. ${secretsNotConfiguredReason()}`}
          />
        </Stack>
      );
    }

    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          headingLevel={3}
          title="Chưa kết nối Fanpage nào"
          description="Chưa có Page nào để đăng bài, nên màn soạn bài sẽ không có kênh để chọn. Sang tab “Kết nối thêm”, dán User Access Token rồi bấm “Lấy danh sách Page” — hệ thống sẽ tự lấy về mọi Page bạn quản lý."
          actions={<Button variant="primary" label="Kết nối Fanpage" onClick={onGoToConnect} />}
        />
      </Stack>
    );
  }

  // --- Data, possibly STALE -------------------------------------------------
  // The dangerous case (business rule 5 at the UI layer): a refetch failed
  // while rows from an earlier answer are still on screen. Hiding the failure
  // would let an operator act on a list that no longer matches the server —
  // they would post to a Page that was disabled a minute ago. So the rows stay
  // (they are still the best information we have) and the failure is said out
  // loud, with the server's own reason and a way to try again.
  return (
    <Stack direction="vertical" height="100%">
      {isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          <Banner
            status="warning"
            title="Danh sách bên dưới có thể đã cũ — chưa làm mới được"
            description={`${presentApiError(toApiError(error)).description} Những gì đang hiện là kết quả của lần tải gần nhất; hãy thử lại trước khi đăng bài.`}
            endContent={
              <Button variant="secondary" size="sm" label="Thử lại" onClick={onRetry} />
            }
          />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <ChannelTable
          channels={items}
          busyChannelId={busyChannelId}
          areWritesBlocked={areWritesBlocked}
          blockedReasonOverride={blockedReasonOverride}
          onSetStatus={onSetStatus}
          onRemove={onRemove}
        />
      </StackItem>
    </Stack>
  );
}
