"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useId } from "react";
import { useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Textarea } from "@/ui/components/ui/textarea";
import {
  ChannelGroupFormSchema,
  MAX_CHANNELS_PER_GROUP,
  parseChannelIds,
  type ChannelGroupFormValues,
} from "@/ui/schemas/channel-group.schema";

/**
 * Create/edit form of a preset channel group (E7.6). RHF + zod resolver, one
 * schema shared with the list screen (web-form-architecture rule 1).
 *
 * Both modes use the SAME component: "sửa" is the same three fields with other
 * defaults, and duplicating it would guarantee the two drift apart
 * (core-component-reuse).
 *
 * a11y: every field has a real <label>, errors are wired with
 * `aria-describedby` + `aria-invalid`, and the server's inline reason (kênh lạ,
 * trùng tên) is rendered in the same place as a client-side one.
 */
export function ChannelGroupForm({
  mode,
  defaultValues,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  defaultValues?: ChannelGroupFormValues;
  pending: boolean;
  /** Server-side refusal for THIS form (INVALID_INPUT with a Vietnamese reason). */
  error?: unknown;
  onSubmit: (values: { name: string; channelIds: string[] }) => void;
  onCancel?: () => void;
}) {
  const nameId = useId();
  const channelsId = useId();
  const channelsHintId = `${channelsId}-hint`;

  const form = useForm<ChannelGroupFormValues>({
    resolver: zodResolver(ChannelGroupFormSchema),
    mode: "onSubmit",
    defaultValues: defaultValues ?? { name: "", channelIdsText: "" },
  });

  const nameError = form.formState.errors.name?.message;
  const channelsError = form.formState.errors.channelIdsText?.message;

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit((values) =>
        onSubmit({ name: values.name.trim(), channelIds: parseChannelIds(values.channelIdsText) }),
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

      <div className="space-y-1.5">
        <label htmlFor={channelsId} className="text-sm font-medium">
          Mã kênh (mỗi dòng một mã)
        </label>
        <Textarea
          id={channelsId}
          {...form.register("channelIdsText")}
          aria-invalid={channelsError ? true : undefined}
          aria-describedby={
            channelsError ? `${channelsId}-error ${channelsHintId}` : channelsHintId
          }
          placeholder={"facebook\nfacebook-page-2"}
          spellCheck={false}
        />
        <p id={channelsHintId} className="text-muted-foreground text-xs">
          Nhập mã kênh đã được cấu hình trong hệ thống (tối đa {MAX_CHANNELS_PER_GROUP} kênh). Màn
          hình kết nối Fanpage thật (Page ID + token) thuộc phần đăng Facebook — chưa có trong bản
          này, nên mã kênh phải nhập tay. Mã không tồn tại sẽ bị máy chủ từ chối kèm tên mã.
        </p>
        {channelsError ? (
          <p id={`${channelsId}-error`} role="alert" className="text-destructive text-sm">
            {channelsError}
          </p>
        ) : null}
      </div>

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
