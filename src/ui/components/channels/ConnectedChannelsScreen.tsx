"use client";

import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Heading,
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  Stack,
  StackItem,
  Text,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ChannelConnectPanel } from "@/ui/components/channels/ChannelConnectPanel";
import { ChannelTable } from "@/ui/components/channels/ChannelTable";
import { ChannelTableSkeleton } from "@/ui/components/channels/ChannelTableSkeleton";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { presentApiError, toApiError } from "@/ui/components/feedback/present-api-error";
import { useChannels, useRemoveChannel, useSetChannelStatus } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import {
  parseConnectOutcome,
  type Channel,
  type ChannelStatus,
  type ConnectOutcome,
} from "@/ui/schemas/channel.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";

/**
 * "Kênh" (E5.1): the Fanpages this tenant may publish to — the screen that has
 * to exist before a channel group can contain anything real.
 *
 * Frame (`astryx docs layout`, tracker archetype): header carries the title and
 * the reload action, the content region carries the connect block and then the
 * rows edge-to-edge. No inspector panel — a Page has five fields, and they all
 * fit in the row.
 *
 * The four mandatory states live in `ChannelListBody`:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — one row per Page, each with bật/tắt and gỡ
 *   empty   — the important one: explains what to do and points at the token box
 *   error   — via `presentApiError` (4xx: sửa dữ liệu; 5xx: thử lại)
 *
 * The OAuth callback lands here as `?connected=n`, `?connect=cancelled` or
 * `?connect=error&reason=…`. It is read once into state and then wiped from the
 * URL, so F5 does not replay a stale message (web-auth-methods §4).
 */
export function ConnectedChannelsScreen() {
  // Phase 1 is single-tenant in the UI; E10.4 will read it from the session.
  const tenantId = DEMO_TENANT_ID;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const channels = useChannels(tenantId);
  const setStatus = useSetChannelStatus(tenantId);
  const remove = useRemoveChannel(tenantId);

  const tokenInputRef = useRef<HTMLInputElement | null>(null);

  const search = searchParams.toString();
  const [lastReadSearch, setLastReadSearch] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  const [isOutcomeDismissed, setIsOutcomeDismissed] = useState(false);

  // Adjusting state during render (the documented React alternative to an
  // effect): the callback is read ONCE, and its message has to survive the URL
  // rewrite below — reading it straight from `searchParams` would make the
  // banner vanish the moment the params are wiped.
  if (lastReadSearch !== search) {
    setLastReadSearch(search);
    const parsed = parseConnectOutcome(new URLSearchParams(search));
    if (parsed) {
      setOutcome(parsed);
      setIsOutcomeDismissed(false);
    }
  }

  const refetchChannels = channels.refetch;
  useEffect(() => {
    const parsed = parseConnectOutcome(new URLSearchParams(search));
    if (!parsed) return;

    // Drop the callback params: the message now lives in state, and a reload
    // must not resurrect "Đã kết nối 2 Page" hours later.
    router.replace(pathname, { scroll: false });

    // The list may already be cached from an earlier visit in this tab; a
    // finished OAuth round trip means it is out of date by definition.
    if (parsed.kind === "connected") void refetchChannels();
  }, [search, pathname, router, refetchChannels]);

  const items = channels.data?.channels ?? [];
  const isFirstLoad = channels.isPending && channels.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const busyChannelId = setStatus.isPending
    ? (setStatus.variables?.channelId ?? null)
    : remove.isPending
      ? (remove.variables?.channelId ?? null)
      : null;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Kênh</Heading>
              <Text type="supporting">
                Những Fanpage bài viết có thể được đăng lên. Kênh đang tắt vẫn nằm trong nhóm kênh
                nhưng sẽ bị bỏ qua khi đăng — tắt là cách dừng một Page mà không mất cấu hình.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label={channels.isFetching ? "Đang tải…" : "Tải lại"}
                isDisabled={channels.isFetching}
                onClick={() => void channels.refetch()}
              />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {outcome && !isOutcomeDismissed ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ConnectOutcomeBanner
                  outcome={outcome}
                  onDismiss={() => setIsOutcomeDismissed(true)}
                />
              </Stack>
            ) : null}

            <Stack direction="vertical" padding={4}>
              <ChannelConnectPanel tenantId={tenantId} tokenInputRef={tokenInputRef} />
            </Stack>

            <Divider />

            <StackItem size="fill">
              <Stack direction="vertical" height="100%">
                <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
                  <Heading level={2}>Page đã kết nối</Heading>
                  {/* Only once the list is real: "0 Page" while loading reads as
                      an answer, and the operator would act on it. */}
                  {channels.data ? (
                    <Text type="supporting" role="status" aria-live="polite">
                      {items.length} Page
                    </Text>
                  ) : null}
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
                    onFocusTokenInput={() => tokenInputRef.current?.focus()}
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
            </StackItem>
          </Stack>
        </LayoutContent>
      }
    />
  );
}

/** Cancelling at Facebook's consent screen is not an error — do not paint it red. */
function ConnectOutcomeBanner({
  outcome,
  onDismiss,
}: {
  outcome: ConnectOutcome;
  onDismiss: () => void;
}) {
  if (outcome.kind === "connected") {
    return (
      <Banner
        status="success"
        isDismissable
        onDismiss={onDismiss}
        title={
          outcome.count === null
            ? "Đã kết nối xong với Facebook"
            : outcome.count === 0
              ? "Không có Page mới nào được thêm"
              : `Đã kết nối ${outcome.count} Page`
        }
        description="Kiểm tra danh sách bên dưới trước khi đăng bài — chỉ những Page đang bật mới nhận bài."
      />
    );
  }

  if (outcome.kind === "cancelled") {
    return (
      <Banner
        status="info"
        isDismissable
        onDismiss={onDismiss}
        title="Bạn đã huỷ ở màn hình Facebook"
        description="Không có gì thay đổi. Bấm “Đăng nhập bằng Facebook” để thử lại, hoặc dán User Access Token ở ô phía trên."
      />
    );
  }

  return (
    <Banner
      status="error"
      title="Không kết nối được với Facebook"
      description={
        outcome.reason === null
          ? "Facebook trả về một kết quả không đọc được. Hãy thử lại; nếu vẫn lỗi, báo quản trị viên."
          : `Facebook từ chối yêu cầu kết nối. Hãy thử lại; nếu vẫn lỗi, báo quản trị viên kèm mã: ${outcome.reason}`
      }
    />
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
  onFocusTokenInput,
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
  onFocusTokenInput: () => void;
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
    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          headingLevel={3}
          title="Chưa kết nối Fanpage nào"
          description="Chưa có Page nào để đăng bài, nên màn soạn bài sẽ không có kênh để chọn. Dán User Access Token ở khối phía trên rồi bấm “Lấy danh sách Page” — hệ thống sẽ tự lấy về mọi Page bạn quản lý."
          actions={
            <Button variant="primary" label="Nhập token ở phía trên" onClick={onFocusTokenInput} />
          }
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
          onSetStatus={onSetStatus}
          onRemove={onRemove}
        />
      </StackItem>
    </Stack>
  );
}
