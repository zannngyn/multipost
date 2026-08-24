"use client";

import {
  Banner,
  Button,
  Divider,
  Grid,
  Heading,
  Icon,
  Section,
  Stack,
  Text,
} from "@astryxdesign/core";
import { useFormStatus } from "react-dom";

/**
 * `/signin` — the split sign-in screen (E10).
 *
 * Two halves, one purpose: the left half says what this tool is (an operator
 * who lands here from a middleware redirect may never have seen it), the right
 * half is the only way in.
 *
 * Responsive contract:
 *   >= ~920px  brand column | auth column, 50/50
 *   <  ~920px  one column — brand stacks ABOVE the auth column. It is not
 *              hidden: the five lines below it are the only explanation of what
 *              the operator is signing in to, and hiding them on a phone would
 *              leave a bare pair of buttons.
 *
 * EVERY CONTROL ON THIS SCREEN WORKS (spec §3.7). It used to also carry a
 * disabled email/password block, a dead "Quên mật khẩu" link and a
 * "Đăng nhập / Đăng ký" tab strip whose only effect was relabelling that block
 * — a preview of a feature with no ticket behind it. Showing an operator two
 * ways in and then refusing one of them costs more trust than the empty space
 * costs curiosity, and the tab strip made the screen look like it had a state
 * to choose before the two buttons that actually sign anyone in.
 *
 * What is left: the Google and Facebook forms. Each is a plain `<form action>`
 * with a Server Action, so they submit before the client bundle loads
 * (web-auth-flows rule 5) — this page is the front door.
 */

/** Why the product exists, in the operator's words — not feature names. */
const VALUE_POINTS = [
  "Đăng bài Facebook hàng loạt, chạy tự động",
  "AI viết caption riêng cho từng kênh",
  "Kiểm tồn kho trước khi đăng — hết hàng là chặn",
  "Quản lý nhiều kênh, chống đăng trùng",
  "Người duyệt kiểm soát trước khi bài lên",
] as const;

export type SignInScreenProps = {
  /** Already sanitised by `safeReturnUrl` on the server; travels in a hidden field. */
  returnUrl: string;
  /** True when `returnUrl` is the plain home page — then there is nothing to announce. */
  isDefaultReturnUrl: boolean;
  /** Vietnamese sentence for `?error=`, or null when the visit is clean. */
  errorMessage: string | null;
  /** Raw code, only when it has no translation — support needs to hear it. */
  unknownErrorCode: string | null;
  /** The account exists and is queued for an admin. Not a failure. */
  isPendingApproval: boolean;
  signInWithGoogle: (formData: FormData) => Promise<void>;
  signInWithFacebook: (formData: FormData) => Promise<void>;
};

export function SignInScreen({
  returnUrl,
  isDefaultReturnUrl,
  errorMessage,
  unknownErrorCode,
  isPendingApproval,
  signInWithGoogle,
  signInWithFacebook,
}: SignInScreenProps) {
  return (
    <Grid
      columns={{ minWidth: 460, max: 2, repeat: "fit" }}
      gap={0}
      width="100%"
      className="flex-1"
    >
      <BrandColumn />

      <Section variant="transparent" padding={8}>
        <Stack direction="vertical" vAlign="center" height="100%">
          <Stack
            direction="vertical"
            gap={4}
            width="100%"
            maxWidth={420}
            className="mx-auto"
            as="section"
            aria-label="Tự động hóa cùng MYSP ngay"
          >
            <Heading level={2}>Tự động hóa cùng MYSP ngay</Heading>

            {/* Neither banner is decoration: they are the only explanation an
                operator gets for a round trip that ended back here. */}
            {isPendingApproval ? (
              // `status="info"` + `role="status"`, never error red: the request
              // was recorded and is waiting for a human. Someone who reads
              // "bị từ chối" goes and asks for a second account instead of
              // waiting five minutes (core-feedback-states).
              <Banner
                status="info"
                role="status"
                title="Tài khoản đang chờ quản trị viên duyệt"
                description="Yêu cầu truy cập của bạn đã được ghi nhận. Vui lòng đợi quản trị viên duyệt."
              />
            ) : null}

            {errorMessage ? (
              <Stack direction="vertical" gap={1}>
                <Banner
                  status="error"
                  role="alert"
                  title="Không đăng nhập được"
                  description={errorMessage}
                />
                {unknownErrorCode ? (
                  <Text type="code" size="xsm" color="secondary">
                    Mã lỗi: {unknownErrorCode}
                  </Text>
                ) : null}
              </Stack>
            ) : null}

            {/* Two independent forms, not one with two buttons: each carries its
                own Server Action, and a failure of one must not touch the other.
                Grid, not HStack: the pair sits side by side while there is room
                and drops to one per row on a narrow screen, without a media
                query. */}
            <Stack direction="vertical" gap={2}>
              <Grid columns={{ minWidth: 170, max: 2, repeat: "fit" }} gap={3}>
                {/* E5.2 — the same round trip signs the operator in AND brings
                    back the Page tokens, so a successful Facebook sign-in leaves
                    the channels already connected. That extra payoff is why it
                    carries the primary weight. Full-page redirect, never a popup
                    (web-auth-methods rule 1). */}
                <ProviderForm
                  action={signInWithFacebook}
                  returnUrl={returnUrl}
                  label="Tiếp tục với Facebook"
                  pendingLabel="Đang chuyển sang Facebook…"
                  variant="primary"
                />
                <ProviderForm
                  action={signInWithGoogle}
                  returnUrl={returnUrl}
                  label="Tiếp tục với Google"
                  pendingLabel="Đang chuyển sang Google…"
                  variant="secondary"
                />
              </Grid>

              {/* One shared line for both buttons. Two separate paragraphs said
                  the same thing twice and pushed the terms line off the fold. */}
              <Text type="supporting">
                Liên hệ với MYSP ngay để nhận hỗ trợ.
              </Text>
            </Stack>

            {isDefaultReturnUrl ? null : (
              <Text type="supporting">
                Sau khi đăng nhập, bạn sẽ quay lại: <Text type="code">{returnUrl}</Text>
              </Text>
            )}

            <Text type="supporting">
              Khi tiếp tục, bạn đồng ý với quy định sử dụng nội bộ của MYSP.
            </Text>

            <Divider />

            <Stack direction="vertical" as="footer">
              <Text type="supporting">© MYSP 2026. All rights reserved.</Text>
            </Stack>
          </Stack>
        </Stack>
      </Section>
    </Grid>
  );
}

/**
 * The left half. Pure typography and tokens — no bitmap collage, because the
 * only pictures this product owns are customer product photos and none of them
 * belong on a public sign-in page.
 */
function BrandColumn() {
  return (
    <Section
      variant="transparent"
      padding={8}
      // The one gradient on the screen, mixed from the app's own semantic
      // tokens (accent -> muted -> background), so it re-values itself with the
      // theme instead of freezing a pair of hex stops.
      className="bg-linear-to-br from-accent/35 via-muted to-background"
    >
      <Stack direction="vertical" gap={6} height="100%" vAlign="center">
        <Stack direction="horizontal" gap={2} align="center" as="header">
          <Text weight="bold" size="lg">
            MYSP
          </Text>
          <Text type="supporting">Đăng bài tự động</Text>
        </Stack>

        <Stack direction="vertical" gap={2}>
          <Heading level={1} type="display-2">
            Bắt đầu ngay hôm nay
          </Heading>
          <Text type="supporting">
            Công cụ soạn, duyệt và đăng bài đa nền tảng
          </Text>
        </Stack>

        <Stack direction="vertical" gap={2} as="ul" className="list-none">
          {VALUE_POINTS.map((point) => (
            // The tick is decorative: the sentence beside it carries the whole
            // meaning, so Icon stays aria-hidden (its default).
            <Stack key={point} direction="horizontal" gap={2} align="start" as="li">
              <Icon icon="check" color="success" size="sm" />
              <Text>{point}</Text>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Section>
  );
}

/**
 * One provider = one real `<form action>`.
 *
 * `signIn()` throws NEXT_REDIRECT, so the Server Action must never wrap it in
 * try/catch — swallowing that signal would leave the operator on a page that
 * looks like it did nothing (web-data-fetching rule 4). The action lives in the
 * page; this component only carries it.
 */
function ProviderForm({
  action,
  returnUrl,
  label,
  pendingLabel,
  variant,
}: {
  action: (formData: FormData) => Promise<void>;
  returnUrl: string;
  label: string;
  pendingLabel: string;
  variant: "primary" | "secondary";
}) {
  return (
    // A raw <form>: Astryx has no form primitive, and this element is the whole
    // point — it submits without JavaScript.
    <form action={action}>
      {/* Re-sanitised server-side by `safeReturnUrl` on the way back in: this
          field is client-visible and therefore client-editable. */}
      <input type="hidden" name="returnUrl" value={returnUrl} />
      <ProviderSubmitButton label={label} pendingLabel={pendingLabel} variant={variant} />
    </form>
  );
}

/**
 * The submit button, split out only because `useFormStatus` reads the status of
 * the form it is rendered INSIDE. The OAuth hop takes a visible moment; without
 * this the operator sees a dead button and clicks it again.
 *
 * No hand-rolled live region here: Astryx's Button already renders a
 * `VisuallyHidden` with `aria-live="polite"` while `isLoading`
 * (dist/Button/Button.js:481-484), and sets `aria-label` from `label` in that
 * state — so swapping the label to `pendingLabel` is what gets announced. A
 * second region of our own read the same sentence twice.
 */
function ProviderSubmitButton({
  label,
  pendingLabel,
  variant,
}: {
  label: string;
  pendingLabel: string;
  variant: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant={variant}
      size="lg"
      width="100%"
      label={pending ? pendingLabel : label}
      isLoading={pending}
    />
  );
}
