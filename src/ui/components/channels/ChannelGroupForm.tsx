"use client";

import {
  Button,
  CheckboxList,
  CheckboxListItem,
  HStack,
  Link,
  Skeleton,
  Text,
  TextInput,
  VStack,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import {
  ChannelGroupFormSchema,
  MAX_CHANNELS_PER_GROUP,
  type ChannelGroupFormValues,
} from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * Create/edit form of a preset channel group (E7.6). RHF + zod resolver, one
 * schema shared with the list screen (web-form-architecture rule 1).
 *
 * Channels are TICKED from the tenant's connected Pages (E5.1) — the free-text
 * box this used to have could only ever produce ids the server rejected. Only
 * `status === "active"` channels are offered: a disabled Page is skipped at
 * publish time, so putting it in a group would promise a post that never goes
 * out. The filtering happens in the screen; this component renders what it gets.
 *
 * Both modes use the SAME component: "sửa" is the same two fields with other
 * defaults, and duplicating it would guarantee the two drift apart
 * (core-component-reuse).
 *
 * a11y comes from the primitives rather than by hand: `TextInput` and
 * `CheckboxList` each own their label, their description and their error
 * wiring, which is what stops the three from drifting apart per form
 * (core-form-architecture §a11y).
 */
export function ChannelGroupForm({
  mode,
  defaultValues,
  channels,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  defaultValues?: ChannelGroupFormValues;
  /** The tickable channels plus how their own request went (4 states below). */
  channels: {
    items: readonly Channel[];
    isLoading: boolean;
    error?: unknown;
    onRetry: () => void;
  };
  pending: boolean;
  /** Server-side refusal for THIS form (INVALID_INPUT with a Vietnamese reason). */
  error?: unknown;
  onSubmit: (values: { name: string; channelIds: string[] }) => void;
  onCancel?: () => void;
}) {
  const form = useForm<ChannelGroupFormValues>({
    resolver: zodResolver(ChannelGroupFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: defaultValues ?? { name: "", channelIds: [] },
  });

  const nameError = form.formState.errors.name?.message;
  const channelsError = form.formState.errors.channelIds?.message;

  /**
   * Ids the group already holds that are NOT in the offered list any more —
   * the Page was disabled or removed after the group was made. They still get
   * a (ticked) row, otherwise saving would drop them without a word.
   * Derived from the defaults, not from the live value, so the row does not
   * disappear the moment it is unticked.
   */
  const knownIds = new Set(channels.items.map((channel) => channel.channelId));
  const orphanIds = (defaultValues?.channelIds ?? []).filter((id) => !knownIds.has(id));

  // No channel to tick at all: a form with an empty picker is a dead end. Say
  // what is missing and where to fix it instead (core-feedback-states: every
  // message has a way out).
  if (
    !channels.isLoading &&
    !channels.error &&
    channels.items.length === 0 &&
    orphanIds.length === 0
  ) {
    return (
      <VStack gap={2}>
        <Text type="supporting">
          Chưa có kênh nào đang bật để thêm vào nhóm. Hãy kết nối Fanpage ở màn Kênh trước, rồi quay
          lại đây gom nhóm.
        </Text>
        <Link href="/channels" isStandalone>
          Mở màn Kênh
        </Link>
      </VStack>
    );
  }

  const channelsHint = `Tick những Page bài viết sẽ được đăng lên (tối đa ${MAX_CHANNELS_PER_GROUP} kênh). Danh sách chỉ hiện Page đang bật ở màn Kênh.`;

  return (
    // noValidate: the messages below are ours, not the browser's.
    <form
      noValidate
      onSubmit={form.handleSubmit((values) =>
        onSubmit({ name: values.name.trim(), channelIds: [...values.channelIds] }),
      )}
    >
      <VStack gap={4}>
        <Controller
          control={form.control}
          name="name"
          render={({ field }) => (
            <TextInput
              ref={field.ref}
              label="Tên nhóm kênh"
              htmlName={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              placeholder="Ví dụ: Fanpage chính"
              isRequired
              isDisabled={pending}
              disabledMessage={pending ? "Đang lưu — chờ lưu xong rồi mới sửa tiếp được." : undefined}
              status={nameError ? { type: "error", message: nameError } : undefined}
              statusVariant="detached"
              width="100%"
            />
          )}
        />

        <Controller
          control={form.control}
          name="channelIds"
          render={({ field }) => {
            // --- The picker's own three states, before the happy path -------
            if (channels.isLoading) {
              return (
                <VStack gap={2} aria-busy="true">
                  <Text type="label">Kênh trong nhóm</Text>
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} width="70%" height={20} index={row} />
                  ))}
                </VStack>
              );
            }

            if (channels.error) {
              return (
                <VStack gap={2}>
                  <Text type="label">Kênh trong nhóm</Text>
                  <ApiErrorNotice error={channels.error} onRetry={channels.onRetry} />
                </VStack>
              );
            }

            return (
              <CheckboxList
                label="Kênh trong nhóm"
                description={channelsHint}
                density="compact"
                // Every row carries helper text under its label; without
                // dividers the two blur together (CheckboxList best practice).
                hasDividers
                value={field.value}
                onChange={field.onChange}
                isDisabled={pending}
                disabledMessage={pending ? "Đang lưu — chờ lưu xong rồi mới sửa tiếp được." : undefined}
                status={channelsError ? { type: "error", message: channelsError } : undefined}
                width="100%"
              >
                {channels.items.map((channel) => (
                  <CheckboxListItem
                    key={channel.channelId}
                    value={channel.channelId}
                    label={
                      channel.name.trim().length > 0 ? channel.name : "(Page chưa có tên)"
                    }
                    description={channel.externalId}
                  />
                ))}

                {orphanIds.map((channelId) => (
                  // The server refuses a group containing a disabled or deleted
                  // channel (CHANNEL_DISABLED), so the tick is a dead end. Say
                  // what to DO, not just what happened — otherwise "Lưu" fails
                  // and nothing on screen explains which row caused it.
                  <CheckboxListItem
                    key={channelId}
                    value={channelId}
                    label={channelId}
                    aria-label={`Kênh ${channelId} — đã tắt hoặc đã bị gỡ`}
                    description="Kênh này đã tắt hoặc đã bị gỡ ở màn Kênh. Bỏ tick kênh này để lưu được, hoặc bật lại nó ở màn Kênh trước."
                  />
                ))}
              </CheckboxList>
            );
          }}
        />

        {error ? <ApiErrorNotice error={error} /> : null}

        <HStack gap={2} wrap="wrap">
          {/* Never disabled on "invalid": the operator presses it and the field
              says what is wrong (core-form-architecture §submit). */}
          <Button
            type="submit"
            variant="primary"
            label={
              pending
                ? mode === "create"
                  ? "Đang tạo…"
                  : "Đang lưu…"
                : mode === "create"
                  ? "Tạo nhóm"
                  : "Lưu thay đổi"
            }
            isLoading={pending}
            isDisabled={pending}
          />
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              label="Huỷ"
              isDisabled={pending}
              onClick={onCancel}
            />
          ) : null}
        </HStack>
      </VStack>
    </form>
  );
}
