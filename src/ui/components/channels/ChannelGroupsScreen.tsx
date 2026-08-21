"use client";

import {
  Badge,
  Banner,
  Button,
  Divider,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  List,
  ListItem,
  Skeleton,
  Stack,
  StackItem,
  Text,
  Token,
  VStack,
  useMediaQuery,
} from "@astryxdesign/core";
import { useState, type ReactNode } from "react";

import { ChannelGroupForm } from "@/ui/components/channels/ChannelGroupForm";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import {
  useChannelGroups,
  useCreateChannelGroup,
  useDeleteChannelGroup,
  useUpdateChannelGroup,
} from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * "Nhóm kênh" (E7.6 / E10.3): component -> hook -> service -> internal API.
 *
 * A group is a SHORTCUT for the wizard's channel picker, never an authority:
 * fan-out still creates one post_job per channel and the publish rules (kiểm
 * tồn lần 2, giãn cách, khoá chống trùng) are untouched by what is ticked here.
 *
 * Frame (`astryx docs layout`, tracker archetype): the saved groups are rows in
 * the content region and the create/edit form lives in a panel beside them. The
 * screen used to be a scroll column of identical cards with a form on top —
 * card soup, and the form pushed the list off the first screen. Rows also make
 * the real question ("nhóm nào có kênh nào?") answerable without scrolling.
 *
 * Responsive contract:
 *   > 1024px  content (rows) | panel 380 (form)
 *   <= 1024px panel drops; the form renders above the rows, in the same order
 *             an operator reads them
 *
 * The four mandatory states:
 *   loading — skeleton rows, delayed 300ms
 *   data    — one row per group, each with sửa + xoá
 *   empty   — first-run box explaining what a group is for
 *   error   — via `presentApiError` (4xx: sửa dữ liệu; 5xx: thử lại)
 *
 * Delete asks first, in place — the row's action slot swaps to a question and
 * two buttons, the same gesture "Kênh" uses. No `confirm()`: it cannot be
 * styled, blocks the main thread and is announced inconsistently.
 */
export function ChannelGroupsScreen() {
  const groups = useChannelGroups();
  const create = useCreateChannelGroup();
  const update = useUpdateChannelGroup();
  const remove = useDeleteChannelGroup();
  const channels = useChannels();

  // Below 1024px the panel would squeeze the rows to nothing, so it drops and
  // the form takes its place at the top of the content region.
  const isNarrow = useMediaQuery("(max-width: 1024px)");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const isFirstLoad = groups.isPending && groups.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const items = groups.data?.groups ?? [];

  /**
   * A group may only hold channels that are actually publishable: a disabled
   * Page is skipped at publish time, so offering it here would promise a post
   * that never goes out. The picker therefore sees ACTIVE channels only.
   */
  const pickableChannels = {
    items: (channels.data?.channels ?? []).filter((channel) => channel.status === "active"),
    isLoading: channels.isPending && channels.fetchStatus === "fetching",
    error: channels.isError ? channels.error : undefined,
    onRetry: () => void channels.refetch(),
  };

  // Support mode is read-only (M3.3): creating, editing and deleting a group
  // all answer 403, so the controls go off with the reason attached rather
  // than staying live to fail.
  const readOnlyReason = useReadOnlyReason();
  const gate = writeGate(readOnlyReason);

  const editing = items.find((group) => group.id === editingId) ?? null;

  const formBlock = (
    <VStack gap={3}>
      <Heading level={2}>{editing ? `Sửa nhóm “${editing.name}”` : "Tạo nhóm mới"}</Heading>

      {gate.isDisabled ? (
        // The whole form goes, not just its button: a form nobody can submit
        // invites typing that gets thrown away.
        <ReadOnlyNotice reason={gate.reason} />
      ) : editing ? (
        <ChannelGroupForm
          // Remounts per group: the fields must start from THAT group's values,
          // and a stale error from the previous one must not survive.
          key={editing.id}
          mode="edit"
          defaultValues={{ name: editing.name, channelIds: [...editing.channelIds] }}
          channels={pickableChannels}
          pending={update.isPending}
          error={update.isError ? update.error : undefined}
          onCancel={() => {
            update.reset();
            setEditingId(null);
          }}
          onSubmit={(values) => {
            update.reset();
            update.mutate(
              { groupId: editing.id, ...values },
              { onSuccess: () => setEditingId(null) },
            );
          }}
        />
      ) : (
        <ChannelGroupForm
          mode="create"
          channels={pickableChannels}
          pending={create.isPending}
          error={create.isError ? create.error : undefined}
          onSubmit={(values) => {
            create.reset();
            create.mutate(values);
          }}
        />
      )}

      {!editing && create.isSuccess ? (
        <Banner
          status="success"
          role="status"
          title={`Đã tạo nhóm “${create.data.name}” với ${create.data.channelCount} kênh.`}
        />
      ) : null}
    </VStack>
  );

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={1} padding={4} maxWidth={760}>
            <Heading level={1}>Nhóm kênh</Heading>
            <Text type="supporting">
              Gom sẵn các kênh hay đăng cùng nhau để ở màn soạn bài chỉ cần tick một lần. Nhóm chỉ
              là lối tắt chọn kênh — mọi quy tắc đăng (kiểm tồn, giãn cách, chống trùng) vẫn giữ
              nguyên.
            </Text>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {isNarrow ? (
              <>
                <Stack direction="vertical" padding={4}>
                  {formBlock}
                </Stack>
                <Divider />
              </>
            ) : null}

            <HStack gap={3} paddingInline={4} paddingBlock={3} align="center" wrap="wrap">
              <Heading level={2}>Nhóm đã lưu</Heading>
              {/* Only once the list is real: "0 nhóm" while loading reads as an
                  answer, and the operator would act on it. */}
              {groups.data ? (
                <Text type="supporting" role="status" aria-live="polite">
                  {items.length} nhóm
                </Text>
              ) : null}
            </HStack>

            {remove.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={0}>
                <ApiErrorNotice error={remove.error} />
              </Stack>
            ) : null}

            <StackItem size="fill">
              <ChannelGroupsBody
                isFirstLoad={isFirstLoad}
                showSkeleton={showSkeleton}
                isError={groups.isError}
                error={groups.error}
                onRetry={() => void groups.refetch()}
                items={items}
                editingId={editingId}
                confirmingId={confirmingId}
                isRemoving={remove.isPending}
                gate={gate}
                onEdit={(groupId) => {
                  update.reset();
                  setConfirmingId(null);
                  setEditingId(groupId);
                }}
                onAskRemove={(groupId) => {
                  remove.reset();
                  setEditingId(null);
                  setConfirmingId(groupId);
                }}
                onCancelRemove={() => setConfirmingId(null)}
                onConfirmRemove={(groupId) => {
                  remove.reset();
                  remove.mutate({ groupId }, { onSuccess: () => setConfirmingId(null) });
                }}
              />
            </StackItem>
          </Stack>
        </LayoutContent>
      }
      end={
        isNarrow ? undefined : (
          <LayoutPanel
            width={380}
            hasDivider
            isScrollable
            label={editing ? "Sửa nhóm kênh" : "Tạo nhóm kênh mới"}
          >
            <Stack direction="vertical" padding={4}>
              {formBlock}
            </Stack>
          </LayoutPanel>
        )
      }
    />
  );
}

function ChannelGroupsBody({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  onRetry,
  items,
  editingId,
  confirmingId,
  isRemoving,
  gate,
  onEdit,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  items: readonly ChannelGroup[];
  editingId: string | null;
  confirmingId: string | null;
  isRemoving: boolean;
  gate: ReturnType<typeof writeGate>;
  onEdit: (groupId: string) => void;
  onAskRemove: (groupId: string) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (groupId: string) => void;
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <ChannelGroupsSkeleton /> : null;

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
          kind="first-run"
          title="Chưa có nhóm kênh nào"
          description="Tạo nhóm đầu tiên bằng biểu mẫu bên cạnh. Khi đã có nhóm, màn soạn bài sẽ hiện danh sách kênh theo nhóm để tick nhanh."
          action={
            // A real link, not a click handler: this is navigation, so
            // Ctrl/Cmd+click, middle-click and "mở tab mới" all have to work,
            // and a screen reader has to hear "liên kết", not "nút".
            <Button variant="secondary" label="Về màn soạn bài" href="/compose" />
          }
        />
      </Stack>
    );
  }

  // --- Data -----------------------------------------------------------------
  return (
    <List hasDividers density="compact">
      {items.map((group) => (
        <ListItem
          key={group.id}
          label={group.name}
          isSelected={editingId === group.id}
          description={
            <VStack gap={1.5}>
              <HStack gap={1.5} wrap="wrap">
                {group.channelIds.map((channelId) => (
                  <Token key={channelId} size="sm" label={channelId} />
                ))}
              </HStack>
              <Text type="supporting" size="2xs" hasTabularNumbers>
                Cập nhật: {formatDateTime(group.updatedAt)}
              </Text>
            </VStack>
          }
          endContent={
            <GroupActions
              group={group}
              isConfirming={confirmingId === group.id}
              isRemoving={isRemoving}
              gate={gate}
              onEdit={() => onEdit(group.id)}
              onAskRemove={() => onAskRemove(group.id)}
              onCancelRemove={onCancelRemove}
              onConfirmRemove={() => onConfirmRemove(group.id)}
            />
          }
        />
      ))}
    </List>
  );
}

/** The row's action slot: two buttons, or the delete question in their place. */
function GroupActions({
  group,
  isConfirming,
  isRemoving,
  gate,
  onEdit,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  group: ChannelGroup;
  isConfirming: boolean;
  isRemoving: boolean;
  gate: ReturnType<typeof writeGate>;
  onEdit: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}): ReactNode {
  if (isConfirming) {
    return (
      <VStack gap={1.5} align="end">
        {/* Announced on mount: a keyboard user must hear the question, not just
            see the buttons change. */}
        <Text type="supporting" role="alert">
          Xoá nhóm “{group.name}”? Bài đã đăng không bị ảnh hưởng — chỉ mất lối tắt chọn kênh này.
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            variant="destructive"
            label={`Xoá hẳn nhóm ${group.name}`}
            isLoading={isRemoving}
            isDisabled={isRemoving}
            onClick={onConfirmRemove}
          >
            Xoá hẳn
          </Button>
          <Button
            size="sm"
            variant="ghost"
            label={`Giữ lại nhóm ${group.name}`}
            isDisabled={isRemoving}
            onClick={onCancelRemove}
          >
            Giữ lại
          </Button>
        </HStack>
      </VStack>
    );
  }

  return (
    <HStack gap={2} align="center" wrap="wrap">
      {/* Badge earns its place here: it is a count, nothing else. */}
      <Badge variant="neutral" label={`${group.channelCount} kênh`} />
      <Button
        size="sm"
        variant="secondary"
        label={`Sửa nhóm ${group.name}`}
        isDisabled={gate.isDisabled}
        // Never a bare disabled button: with a tooltip Astryx keeps the control
        // focusable (aria-disabled), so the reason is reachable by keyboard.
        tooltip={gate.reason ?? undefined}
        onClick={onEdit}
      >
        Sửa
      </Button>
      <Button
        size="sm"
        variant="ghost"
        label={`Xoá nhóm ${group.name}`}
        isDisabled={gate.isDisabled}
        tooltip={gate.reason ?? undefined}
        onClick={onAskRemove}
      >
        Xoá
      </Button>
    </HStack>
  );
}

/** Same row shape as a real group — no jump when the data lands. */
function ChannelGroupsSkeleton() {
  return (
    <Stack direction="vertical" gap={0} aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <HStack key={row} gap={3} paddingInline={4} paddingBlock={3} align="start">
          <StackItem size="fill">
            <VStack gap={1.5}>
              <Skeleton width={180} height={16} index={row} />
              <HStack gap={1.5}>
                <Skeleton width={96} height={20} radius="rounded" index={row} />
                <Skeleton width={112} height={20} radius="rounded" index={row} />
              </HStack>
              <Skeleton width={200} height={12} index={row} />
            </VStack>
          </StackItem>
          <Skeleton width={72} height={20} radius="rounded" index={row} />
          <Skeleton width={64} height={28} index={row} />
          <Skeleton width={64} height={28} index={row} />
        </HStack>
      ))}
    </Stack>
  );
}
