"use client";

import { Button, Divider, Heading, HStack, Link, Stack, Text, TextInput } from "@astryxdesign/core";
import type { TextInputProps } from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import type { RefObject } from "react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { secretsNotConfiguredReason } from "@/ui/components/channels/channel-secrets";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useImportChannels, useRefreshChannels } from "@/ui/hooks/useChannels";
import {
  ChannelImportFormSchema,
  REQUIRED_TOKEN_SCOPES,
  formatImportSummary,
  type ChannelImportFormValues,
} from "@/ui/schemas/channel.schema";
import { channelConnectHref } from "@/ui/services/channel.api";

/**
 * The two ways a Fanpage gets into this tool (E5.1).
 *
 *  1. PRIMARY today — paste a User Access Token. The tenant already has a valid
 *     token but no App Secret, so the OAuth round trip cannot run yet.
 *  1b. "Làm mới danh sách Page" — same import, run with the token the server
 *     already stored. Shown unconditionally: whether that token exists is the
 *     server's knowledge, not something the channel count can stand in for.
 *  2. SECONDARY — "Đăng nhập bằng Facebook", a full-page redirect to
 *     `/api/channels/connect`. Kept visible with an honest note about why it is
 *     not usable yet, instead of a button that dies silently.
 *
 * SECURITY (the reason this component is its own file):
 *  - the token is `type="password"`, no autofill, no spellcheck, no password
 *    manager capture;
 *  - it lives in this form's state and in the POST body, nowhere else — no URL,
 *    no localStorage, no query key, no console;
 *  - the field is emptied and the mutation reset the moment the import lands,
 *    so the value does not linger in the mutation cache either.
 */

/**
 * Astryx `TextInput` forwards unknown props onto its `<input>`, but its prop
 * type extends `HTMLAttributes`: `autoComplete` is not declared there and
 * `spellCheck` is explicitly omitted by `BaseProps`. Hand-rolling a raw
 * `<input>` instead would lose the field's label, description and status
 * wiring, so the two attributes are handed over through one commented cast.
 */
const NO_AUTOFILL = {
  autoComplete: "off",
  spellCheck: false,
} as unknown as Partial<TextInputProps>;

const TOKEN_HINT = `Token phải có đủ quyền: ${REQUIRED_TOKEN_SCOPES.join(", ")}. Token chỉ được gửi thẳng tới máy chủ và không lưu lại trên trình duyệt.`;

export function ChannelConnectPanel({
  tenantId,
  tokenInputRef,
  areWritesBlocked,
}: {
  tenantId: string;
  /** Lets the empty state send the operator straight into the token field. */
  tokenInputRef: RefObject<HTMLInputElement | null>;
  /**
   * Server has no encryption key, so the import cannot store anything. Better
   * to stop the operator before they paste a secret than after 30 seconds of
   * waiting — the read path gives no hint at all that this is broken.
   */
  areWritesBlocked: boolean;
}) {
  const importChannels = useImportChannels(tenantId);
  const refresh = useRefreshChannels(tenantId);

  /**
   * The counts survive `importChannels.reset()` — that reset is what drops the
   * token from the mutation cache, so the summary cannot be read off the
   * mutation itself.
   */
  const [lastImport, setLastImport] = useState<{
    imported: number;
    updated: number;
    skipped?: number;
  } | null>(null);

  const form = useForm<ChannelImportFormValues>({
    resolver: zodResolver(ChannelImportFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { userAccessToken: "" },
  });

  const fieldError = form.formState.errors.userAccessToken?.message;
  const isBusy = importChannels.isPending || refresh.isPending;

  /**
   * Every disabled control below carries this sentence. Astryx keeps a control
   * with `disabledMessage`/`tooltip` focusable via aria-disabled, so a keyboard
   * user reaches the reason too — a dead control that explains nothing is worse
   * than one that fails loudly.
   */
  const blockedReason = areWritesBlocked ? secretsNotConfiguredReason() : undefined;

  function submitToken(values: ChannelImportFormValues) {
    importChannels.reset();
    refresh.reset();
    setLastImport(null);

    importChannels.mutate(
      { userAccessToken: values.userAccessToken },
      {
        onSuccess: (data) => {
          setLastImport({
            imported: data.imported,
            updated: data.updated,
            skipped: data.skipped,
          });
          // Empty the box first, then drop the mutation (and its variables,
          // i.e. the token) from the cache.
          form.reset({ userAccessToken: "" });
          importChannels.reset();
        },
      },
    );
  }

  return (
    <Stack direction="vertical" gap={3}>
      <Stack direction="vertical" gap={1}>
        <Heading level={2}>Kết nối Fanpage</Heading>
        <Text type="supporting">
          Dán User Access Token của Facebook để lấy về danh sách Page bạn quản lý. Hệ thống chỉ lưu
          token của từng Page ở máy chủ — không có token nào hiển thị lại trên màn hình này.
        </Text>
      </Stack>

      {/* noValidate: the messages below are ours, not the browser's. */}
      <form noValidate onSubmit={form.handleSubmit(submitToken)}>
        <Stack direction="vertical" gap={3}>
          <Controller
            control={form.control}
            name="userAccessToken"
            render={({ field }) => (
              <TextInput
                {...NO_AUTOFILL}
                data-1p-ignore=""
                ref={(node: HTMLInputElement | null) => {
                  field.ref(node);
                  tokenInputRef.current = node;
                }}
                label="User Access Token"
                type="password"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                htmlName="userAccessToken"
                placeholder="EAAG…"
                description={TOKEN_HINT}
                isRequired
                isDisabled={isBusy || areWritesBlocked}
                disabledMessage={blockedReason}
                status={fieldError ? { type: "error", message: fieldError } : undefined}
                statusVariant="detached"
                width="100%"
              />
            )}
          />

          <HStack gap={2} wrap="wrap" align="center">
            <Button
              type="submit"
              variant="primary"
              label={importChannels.isPending ? "Đang lấy danh sách Page…" : "Lấy danh sách Page"}
              isLoading={importChannels.isPending}
              isDisabled={refresh.isPending || areWritesBlocked}
              tooltip={blockedReason}
            />

            {/* Always offered, never gated on the number of channels: the real
                precondition is "the server still holds a user token", which
                only the server knows. A tenant that just removed its last Page
                still has that token and must be able to pull the list back.
                With no stored token the server answers CHANNEL_NOT_CONFIGURED
                and its Vietnamese reason lands right below. */}
            <Button
              type="button"
              variant="secondary"
              label={refresh.isPending ? "Đang làm mới…" : "Làm mới danh sách Page"}
              isLoading={refresh.isPending}
              isDisabled={importChannels.isPending || areWritesBlocked}
              tooltip={blockedReason}
              onClick={() => {
                importChannels.reset();
                refresh.reset();
                setLastImport(null);
                refresh.mutate(undefined, {
                  onSuccess: (data) =>
                    setLastImport({
                      imported: data.imported,
                      updated: data.updated,
                      skipped: data.skipped,
                    }),
                });
              }}
            />
          </HStack>

          {lastImport ? (
            <Text role="status" aria-live="polite">
              {formatImportSummary(lastImport)}
            </Text>
          ) : null}

          {/* Both failures land here, right under the box the operator must fix:
              an expired stored token is answered by pasting a new one. */}
          {importChannels.isError ? <ApiErrorNotice error={importChannels.error} /> : null}
          {refresh.isError ? <ApiErrorNotice error={refresh.error} /> : null}
        </Stack>
      </form>

      <Divider />

      <Stack direction="vertical" gap={1}>
        {/* A real anchor: /api/channels/connect answers 302 to Facebook, so this
            must leave the app. Astryx Button cannot wrap an <a>.
            Blocked too: the round trip ends in the same import, so letting it
            run would send the operator to Facebook and back for nothing. */}
        <Link
          href={channelConnectHref(tenantId)}
          isStandalone
          isDisabled={areWritesBlocked}
          tooltip={blockedReason}
        >
          Đăng nhập bằng Facebook
        </Link>
        <Text type="supporting" color="secondary">
          Cách này cần App Secret của ứng dụng Facebook — hiện chưa cấu hình xong, nên hãy dùng ô
          dán token ở trên. Khi quản trị viên nhập App Secret, đường này sẽ chạy được ngay.
        </Text>
      </Stack>
    </Stack>
  );
}
