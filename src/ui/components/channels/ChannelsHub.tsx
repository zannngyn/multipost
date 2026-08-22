"use client";

import {
  Banner,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Stack,
  StackItem,
  Tab,
  TabList,
  Text,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ChannelConnectPanel } from "@/ui/components/channels/ChannelConnectPanel";
import { ChannelGroupsScreen } from "@/ui/components/channels/ChannelGroupsScreen";
import {
  CHANNELS_TABS,
  CHANNELS_TAB_LABELS,
  CHANNELS_TAB_PARAM,
  channelsHubQuery,
  parseChannelsTab,
  resolveActiveChannelsTab,
  type ChannelsTab,
} from "@/ui/components/channels/channels-tabs";
import { secretsNotConfiguredView } from "@/ui/components/channels/channel-secrets";
import { ConnectedChannelsScreen } from "@/ui/components/channels/ConnectedChannelsScreen";
import { useChannels } from "@/ui/hooks/useChannels";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { parseConnectOutcome, type ConnectOutcome } from "@/ui/schemas/channel.schema";

/**
 * "Kênh" — the wave-1 hub over the three views of one subject: the Pages this
 * tenant can publish to ("Page đã kết nối"), the shortcuts built on top of that
 * list ("Nhóm kênh") and the way to add more ("Kết nối thêm").
 * `/channels/groups` redirects here.
 *
 * The hub owns no LIST: each panel keeps its own query and its own loading /
 * data / empty / error states. What it does own is the part that belongs to the
 * address rather than to a panel:
 *   - which view is on screen (`?tab=`), and
 *   - the OAuth callback (`?connected=…`), read once into state so switching
 *     tabs — which rewrites the query — cannot make the message disappear.
 *
 * `TabList`, not `SegmentedControl`: Astryx draws the line at navigation vs
 * input, and these views used to be two routes. Tabs are buttons, not links:
 * Astryx's `Tab href` fires `onChange` on top of the anchor's own navigation,
 * so a link tab would navigate twice (same call as `PostsHub`).
 */
export function ChannelsHub({ tab }: { tab: ChannelsTab }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const channels = useChannels();

  // The URL wins once the client is live (Back/Forward and the redirect from
  // `/channels/groups` both land here); `tab` is what the server already
  // parsed, used until the browser has search params of its own.
  const active = resolveActiveChannelsTab(searchParams.get(CHANNELS_TAB_PARAM), tab);

  const search = searchParams.toString();
  const [lastReadSearch, setLastReadSearch] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  const [isOutcomeDismissed, setIsOutcomeDismissed] = useState(false);

  // Adjusting state during render (the documented React alternative to an
  // effect): the callback is read ONCE, and its message has to survive the URL
  // rewrite below — reading it straight from `searchParams` would make the
  // banner vanish the moment the params are stripped.
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

    // Drop the callback params — the message now lives in state, and a reload
    // must not resurrect "Đã kết nối 2 Page" hours later. `?tab=` is NOT part
    // of the callback and rides through: rewriting to the bare pathname used to
    // throw the operator back to the first tab.
    router.replace(`${pathname}?${channelsHubQuery(search)}`, { scroll: false });

    // The list may already be cached from an earlier visit in this tab; a
    // finished OAuth round trip means it is out of date by definition.
    if (parsed.kind === "connected") void refetchChannels();
  }, [search, pathname, router, refetchChannels]);

  /**
   * Reading channels never touches the encryption key, so a server missing it
   * looks completely healthy on the read path while every write returns 400.
   * Only an EXPLICIT `false` blocks: absent means the field was withheld from
   * this role (M3.3), and a warning nobody on this side can act on is noise.
   *
   * Read here, once, and handed to both panels that can write — the alternative
   * was each panel deriving the same three flags from the same two hooks.
   */
  const secretsMissing = channels.data?.secretsConfigured === false;
  const readOnlyReason = useReadOnlyReason();
  const areWritesBlocked = secretsMissing || readOnlyReason !== null;
  /** Which sentence the tooltips carry. Secrets first: it is the harder stop. */
  const writeBlockReason = secretsMissing ? undefined : (readOnlyReason ?? undefined);

  /**
   * Set when a panel SENT the operator to "Kết nối thêm" to paste a token.
   * STATE, not a ref: the token box now lives behind a disclosure in that
   * panel, so the request has to reach the panel's render — a ref would be
   * invisible to it, and `tokenInputRef.current` would be `null` while the
   * disclosure was still shut.
   */
  const [shouldOpenTokenField, setShouldOpenTokenField] = useState(false);

  const goToTab = useCallback(
    (next: ChannelsTab) => {
      if (next === active) return;
      // Leaving "Kết nối thêm" drops the request: an operator who wandered off
      // and came back later did not ask for a password box to pop open at them.
      if (next !== "connect") setShouldOpenTokenField(false);
      // Only `?tab=` survives the switch: the rest of the query belongs to the
      // view being left. replace(), not push() — this is one page seen three
      // ways, and pushing would make Back walk the operator through every tab
      // click before it leaves the screen (core-routing-patterns §"Điều hướng").
      router.replace(`${pathname}?${CHANNELS_TAB_PARAM}=${next}`, { scroll: false });
    },
    [active, pathname, router],
  );

  /**
   * The flag is set in the SAME handler that switches the tab, so the panel is
   * mounted with it already true and opens its token disclosure on the first
   * frame — see `ChannelConnectPanel`. It is cleared on the way out of the tab
   * (`goToTab` above), which is the only moment it could go stale.
   */
  function goToConnectAndFocusToken() {
    setShouldOpenTokenField(true);
    goToTab("connect");
  }

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Kênh</Heading>
              <Text type="supporting">
                Những Fanpage bài viết có thể được đăng lên, các nhóm kênh dùng để tick nhanh ở màn
                soạn bài, và chỗ kết nối thêm Page mới.
              </Text>
            </Stack>

            {/* The shell's side nav is the other <nav> on the page, so this one
                says what it navigates (core-accessibility §2). */}
            <TabList
              value={active}
              onChange={(value: string) => goToTab(parseChannelsTab(value))}
              aria-label="Chế độ xem kênh"
            >
              {CHANNELS_TABS.map((value) => (
                <Tab key={value} value={value} label={CHANNELS_TAB_LABELS[value]} />
              ))}
            </TabList>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {/* Both banners answer a question about CONNECTING, so they ride
                with the two tabs that do it. Kept out of "Nhóm kênh", where
                neither has anything to do with what is on screen. */}
            {active !== "groups" && outcome && !isOutcomeDismissed ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ConnectOutcomeBanner
                  outcome={outcome}
                  onDismiss={() => setIsOutcomeDismissed(true)}
                />
              </Stack>
            ) : null}

            {/* Before anything is typed, not after it fails: the whole point of
                the flag is that this gap is invisible on the read path. */}
            {active !== "groups" && secretsMissing ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <SecretsNotConfiguredBanner />
              </Stack>
            ) : null}

            <StackItem size="fill">
              {active === "pages" ? (
                <ConnectedChannelsScreen
                  areWritesBlocked={areWritesBlocked}
                  blockedReasonOverride={writeBlockReason}
                  onGoToConnect={goToConnectAndFocusToken}
                />
              ) : active === "connect" ? (
                <Stack direction="vertical" padding={4} maxWidth={880}>
                  <ChannelConnectPanel
                    shouldOpenTokenField={shouldOpenTokenField}
                    areWritesBlocked={areWritesBlocked}
                    blockedReasonOverride={writeBlockReason}
                  />
                </Stack>
              ) : (
                <Stack direction="vertical" padding={4} maxWidth={1024}>
                  <ChannelGroupsScreen />
                </Stack>
              )}
            </StackItem>
          </Stack>
        </LayoutContent>
      }
    />
  );
}

/**
 * Not dismissable: nothing that writes can be saved until an admin acts, so
 * hiding the reason would leave a row of dead buttons with no explanation
 * (core-feedback-states: a serious message must not disappear on its own).
 */
function SecretsNotConfiguredBanner() {
  const view = secretsNotConfiguredView();

  return (
    <Banner
      status="warning"
      title={view.title}
      description={
        view.hint
          ? `Chưa lưu được kênh nào cho đơn vị này. ${view.description} ${view.hint}`
          : `Chưa lưu được kênh nào cho đơn vị này. ${view.description}`
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
        description="Kiểm tra tab “Page đã kết nối” trước khi đăng bài — chỉ những Page đang bật mới nhận bài."
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
        description="Không có gì thay đổi. Sang tab “Kết nối thêm” để thử lại, hoặc dán User Access Token ở đó."
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
