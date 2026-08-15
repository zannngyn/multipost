"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useId } from "react";
import { Controller, useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
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
 * a11y: the name field has a real <label>; the ticks live in a <fieldset> with
 * a <legend>, each with its own <label for> so they are reachable and toggleable
 * by keyboard, and the group's hint + error are wired through aria-describedby.
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
  const nameId = useId();
  const channelsId = useId();
  const channelsHintId = `${channelsId}-hint`;
  const channelsErrorId = `${channelsId}-error`;

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
      <p className="text-muted-foreground text-sm">
        Chưa có kênh nào đang bật để thêm vào nhóm. Hãy{" "}
        <Link href="/channels" className="underline underline-offset-4">
          kết nối Fanpage ở màn Kênh
        </Link>{" "}
        trước, rồi quay lại đây gom nhóm.
      </p>
    );
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit((values) =>
        onSubmit({ name: values.name.trim(), channelIds: [...values.channelIds] }),
      )}
    >
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          Tên nhóm kênh
        </label>
        <Input
          id={nameId}
          {...form.register("name")}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${nameId}-error` : undefined}
          placeholder="Ví dụ: Fanpage chính"
          autoComplete="off"
        />
        {nameError ? (
          <p id={`${nameId}-error`} role="alert" className="text-destructive text-sm">
            {nameError}
          </p>
        ) : null}
      </div>

      <Controller
        control={form.control}
        name="channelIds"
        render={({ field }) => (
          <fieldset
            className="space-y-2"
            aria-describedby={
              channelsError ? `${channelsErrorId} ${channelsHintId}` : channelsHintId
            }
          >
            <legend className="text-sm font-medium">Kênh trong nhóm</legend>
            <p id={channelsHintId} className="text-muted-foreground text-xs">
              Tick những Page bài viết sẽ được đăng lên (tối đa {MAX_CHANNELS_PER_GROUP} kênh). Danh
              sách chỉ hiện Page đang bật ở màn Kênh.
            </p>

            {channels.isLoading ? (
              <div aria-hidden="true" className="space-y-2 motion-safe:animate-pulse">
                {[0, 1].map((row) => (
                  <div key={row} className="bg-muted h-6 w-64 rounded" />
                ))}
              </div>
            ) : channels.error ? (
              <ApiErrorNotice error={channels.error} onRetry={channels.onRetry} />
            ) : (
              <ul className="space-y-1">
                {channels.items.map((channel) => {
                  const optionId = `${channelsId}-${channel.channelId}`;
                  const checked = field.value.includes(channel.channelId);

                  return (
                    <li key={channel.channelId}>
                      {/* Raw checkbox: the project has no ui/checkbox primitive,
                          and the same shape is already used by the wizard's
                          channel picker (core-component-reuse §element table). */}
                      <input
                        type="checkbox"
                        id={optionId}
                        className="accent-primary size-4 align-middle"
                        value={channel.channelId}
                        checked={checked}
                        disabled={pending}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...field.value, channel.channelId]
                            : field.value.filter((id) => id !== channel.channelId);
                          field.onChange(next);
                        }}
                      />
                      <label htmlFor={optionId} className="ml-2 align-middle text-sm">
                        {channel.name.trim().length > 0 ? channel.name : "(Page chưa có tên)"}{" "}
                        <span className="text-muted-foreground font-mono text-xs break-all">
                          {channel.externalId}
                        </span>
                      </label>
                    </li>
                  );
                })}

                {orphanIds.map((channelId) => {
                  const optionId = `${channelsId}-${channelId}`;

                  return (
                    <li key={channelId}>
                      <input
                        type="checkbox"
                        id={optionId}
                        className="accent-primary size-4 align-middle"
                        value={channelId}
                        checked={field.value.includes(channelId)}
                        disabled={pending}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...field.value, channelId]
                            : field.value.filter((id) => id !== channelId);
                          field.onChange(next);
                        }}
                      />
                      {/* The server refuses a group containing a disabled or
                          deleted channel (CHANNEL_DISABLED), so the tick is a
                          dead end. Say what to DO, not just what happened —
                          otherwise "Lưu" fails and nothing on screen explains
                          which row caused it. */}
                      <label htmlFor={optionId} className="ml-2 align-middle text-sm">
                        <span className="text-muted-foreground font-mono text-xs break-all">
                          {channelId}
                        </span>{" "}
                        <span className="text-warning-foreground">
                          — kênh này đã tắt hoặc đã bị gỡ ở màn Kênh.{" "}
                          <strong className="font-medium">Bỏ tick kênh này để lưu được</strong>, hoặc
                          bật lại nó ở màn Kênh trước.
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}

            {channelsError ? (
              <p id={channelsErrorId} role="alert" className="text-destructive text-sm">
                {channelsError}
              </p>
            ) : null}
          </fieldset>
        )}
      />

      {error ? <ApiErrorNotice error={error} /> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? mode === "create"
              ? "Đang tạo…"
              : "Đang lưu…"
            : mode === "create"
              ? "Tạo nhóm"
              : "Lưu thay đổi"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Huỷ
          </Button>
        ) : null}
      </div>
    </form>
  );
}
