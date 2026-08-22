"use client";

import {
  Button,
  Collapsible,
  Divider,
  Heading,
  HStack,
  Stack,
  Text,
  TextInput,
} from "@astryxdesign/core";
import type { TextInputProps } from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { secretsNotConfiguredReason } from "@/ui/components/channels/channel-secrets";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Button as ActionButton } from "@/ui/components/ui/button";
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
 *  1. PRIMARY — "Đăng nhập bằng Facebook", a full-page redirect to
 *     `/api/channels/connect`. This is the route an operator can actually
 *     follow: click, approve, come back with the list. It leads the panel.
 *  2. ADVANCED, behind a disclosure — paste a User Access Token by hand. It
 *     works, and for a tenant with no App Secret it is the ONLY thing that
 *     works, but a password box as the first thing on the screen asks a shop
 *     owner to go find a developer. The disclosure says what it is for.
 *  2b. "Làm mới danh sách Page" — the same import, run with the token the
 *     server already stored. Lives with the token flow it belongs to. Shown
 *     unconditionally: whether that token exists is the server's knowledge, not
 *     something the channel count can stand in for.
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
  shouldOpenTokenField = false,
  areWritesBlocked,
  blockedReasonOverride,
}: {
  /**
   * The empty state on "Trang đã kết nối" sends the operator here to paste a
   * token, and the token box now lives behind a disclosure. A boolean rather
   * than the input ref this used to take: a ref into a subtree that is not
   * mounted is `null`, so the old `tokenInputRef.current?.focus()` would have
   * gone quietly nowhere the day the disclosure closed by default.
   */
  shouldOpenTokenField?: boolean;
  /**
   * Server has no encryption key, so the import cannot store anything. Better
   * to stop the operator before they paste a secret than after 30 seconds of
   * waiting — the read path gives no hint at all that this is broken.
   */
  areWritesBlocked: boolean;
  /** The sentence to show when the block is not the missing key (M3.3). */
  blockedReasonOverride?: string;
}) {
  const importChannels = useImportChannels();
  const refresh = useRefreshChannels();
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Seeded from the prop, not synced to it by an effect. This panel is mounted
   * only while `?tab=connect` is the active tab, and the hub flips the flag in
   * the same handler that switches the tab — so by the time this component
   * exists, the answer is already known and the disclosure can render open on
   * its very first frame. No cascading render, and no shut-then-open blink.
   */
  const [isTokenPanelOpen, setIsTokenPanelOpen] = useState(shouldOpenTokenField);

  /**
   * Focus lands only once the disclosure is open, because that is what mounts
   * the input. Sending someone to another tab without their focus is how a
   * keyboard user ends up typing into the panel they just left.
   */
  useEffect(() => {
    if (!shouldOpenTokenField || !isTokenPanelOpen) return;
    tokenInputRef.current?.focus();
  }, [shouldOpenTokenField, isTokenPanelOpen]);

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
   * The reason every blocked control below is off. It is also rendered as plain
   * text beside the primary action, which is the only route a keyboard user has
   * to it today: that button is a native `<button disabled>`, so it takes no
   * focus and exposes no `disabledMessage`/`tooltip`. The Astryx controls in the
   * manual-token form do carry the sentence on `disabledMessage`/`tooltip`.
   * TODO(wave 2): give the primary action the aria-disabled treatment so the
   * reason is reachable from the control itself, not only from the text below.
   */
  const blockedReason = areWritesBlocked
    ? (blockedReasonOverride ?? secretsNotConfiguredReason())
    : undefined;

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
    <Stack direction="vertical" gap={4}>
      <Stack direction="vertical" gap={1}>
        <Heading level={2}>Kết nối Fanpage</Heading>
        <Text type="supporting">
          Đăng nhập bằng Facebook rồi cấp quyền cho những Page bạn muốn đăng bài. Hệ thống chỉ lưu
          token của từng Page ở máy chủ — không có token nào hiển thị lại trên màn hình này.
        </Text>
      </Stack>

      {/* THE action of this panel, and it looks like it (The One Indigo Rule).
          A real anchor, because /api/channels/connect answers 302 to Facebook
          and the click must leave the app — Astryx Button cannot wrap an <a>,
          so this is the local primitive with `asChild`.
          Blocked too: the round trip ends in the same import, so letting it run
          would send the operator to Facebook and back for nothing. The disabled
          form is a <button>, since a dead anchor is still clickable. */}
      <Stack direction="vertical" gap={1}>
        {areWritesBlocked ? (
          <ActionButton type="button" size="lg" className="self-start" disabled>
            Đăng nhập bằng Facebook
          </ActionButton>
        ) : (
          <ActionButton asChild size="lg" className="self-start">
            <a href={channelConnectHref()}>Đăng nhập bằng Facebook</a>
          </ActionButton>
        )}
        <Text type="supporting" color="secondary">
          Bạn sẽ được chuyển sang Facebook để cấp quyền, xong quay lại đây với danh sách Trang đã
          lấy về. Không cần dán token bằng tay.
        </Text>
        {/* The Named Status Rule: a control that is off says why, right next to
            itself, in words — never by being grey. */}
        {blockedReason ? (
          <Text type="supporting" color="secondary" role="status">
            {blockedReason}
          </Text>
        ) : null}
      </Stack>

      <Divider />

      {/* The manual route, folded away. It is not deprecated — for a tenant
          with no App Secret it is the only one that works — but it asks for a
          secret string, and that is not the first thing a shop owner should
          meet on this screen. */}
      <Collapsible
        isOpen={isTokenPanelOpen}
        onOpenChange={setIsTokenPanelOpen}
        trigger={<span className="text-sm font-medium">Cách nâng cao: dán User Access Token</span>}
      >
        {/* noValidate: the messages below are ours, not the browser's. */}
        <form noValidate onSubmit={form.handleSubmit(submitToken)}>
          <Stack direction="vertical" gap={3}>
            <Text type="supporting" color="secondary">
              Dùng khi công ty chưa cấu hình App Secret nên chưa đăng nhập bằng Facebook được. Token
              chỉ được gửi thẳng tới máy chủ.
            </Text>
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

            {/* Both failures land here, right under the box the operator must
                fix: an expired stored token is answered by pasting a new one. */}
            {importChannels.isError ? <ApiErrorNotice error={importChannels.error} /> : null}
            {refresh.isError ? <ApiErrorNotice error={refresh.error} /> : null}
          </Stack>
        </form>
      </Collapsible>
    </Stack>
  );
}
