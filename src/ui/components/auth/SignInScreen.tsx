"use client";

import {
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  Grid,
  Heading,
  Icon,
  Link,
  Section,
  Stack,
  Tab,
  TabList,
  Text,
  TextInput,
} from "@astryxdesign/core";
import { useState } from "react";
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
 * What is real and what is a preview:
 *   - REAL: the Google and Facebook forms. Each is a plain `<form action>` with
 *     a Server Action, so they submit before the client bundle loads
 *     (web-auth-flows rule 5) — this page is the front door.
 *   - PREVIEW: the email/password fields, "Quên mật khẩu" and the submit button
 *     are disabled and carry a "Sắp ra mắt" badge. They are deliberately NOT
 *     inside a `<form>`: a real login form here would make password managers
 *     offer to fill a box that can never be submitted, and would let Enter
 *     "submit" nothing.
 *
 * The four states, and where each one lives:
 *   loading  `app/signin/loading.tsx` — the split frame in Skeleton form while
 *            the dynamic page renders; plus per-button `isLoading` during the
 *            OAuth hop, which is the only wait this component itself owns.
 *   data     the screen below, on a clean visit.
 *   empty    a clean visit IS the empty state here: there is no list to be
 *            empty of, so the CTA pair is the "what to do next".
 *   error    the `status="error"` Banner from `?error=`, with the untranslated
 *            code underneath for support. `isPendingApproval` is deliberately
 *            NOT one of these — see the comment on that Banner.
 */

/** The two preview tabs. The value lives in state, not the URL: nothing here
 *  can be linked to or bookmarked yet, so a query param would be a promise the
 *  screen cannot keep. */
type AuthTab = "signin" | "signup";

const COMING_SOON_REASON =
  "Đăng nhập bằng email và mật khẩu chưa mở. Hiện tại hãy dùng Google hoặc Facebook bên dưới.";

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
  const [tab, setTab] = useState<AuthTab>("signin");
  const isSignUp = tab === "signup";

  return (
    <Grid
      columns={{ minWidth: 460, max: 2, repeat: "fit" }}
      gap={0}
      width="100%"
      className="flex-1"
    >
      <BrandColumn />

      {/* padding={6}, one step under the brand half: this column carries five
          times the content, and on a phone the extra inline room goes to the
          fields rather than to the margin. The 420px cap keeps both halves
          optically centred anyway. */}
      <Section variant="transparent" padding={6}>
        <Stack direction="vertical" vAlign="center" height="100%">
          <Stack
            direction="vertical"
            gap={5}
            width="100%"
            maxWidth={420}
            className="mx-auto"
            as="section"
            aria-label="Tự động hóa cùng MysP ngay"
          >
            <Heading level={2}>Tự động hóa cùng MysP ngay</Heading>

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

            {/* Astryx TabList renders a <nav> with roving tabindex and
                aria-current — a navigation strip, not a WAI-ARIA tab widget.
                So no role="tab"/"tabpanel" is bolted on here: hand-written ARIA
                on top of a different pattern reads worse than the plain one. */}
            <TabList
              value={tab}
              onChange={(value) => setTab(value as AuthTab)}
              hasDivider
              // Two tabs in a 420px column: `fill` splits the strip evenly so
              // the switcher reads as one control instead of two words adrift
              // at the start edge.
              layout="fill"
              aria-label="Tự động hóa với MysP ngay"
            >
              <Tab value="signin" label="Đăng nhập" />
              <Tab value="signup" label="Đăng ký" />
            </TabList>

            <CredentialsPreview isSignUp={isSignUp} />

            <Divider label="Hoặc" />

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
                Liên hệ với MysP ngay để nhận hỗ trợ.
              </Text>
            </Stack>

            {/* The fine print is one block, not three loose lines: at gap={5}
                the destination note, the terms line and the copyright read as
                three separate claims of equal weight. Tightened to gap={1},
                they read as what they are — a footnote under the buttons. */}
            <Stack direction="vertical" gap={1}>
              {isDefaultReturnUrl ? null : (
                <Text type="supporting">
                  Sau khi đăng nhập, bạn sẽ quay lại: <Text type="code">{returnUrl}</Text>
                </Text>
              )}

              <Text type="supporting">
                Khi tiếp tục, bạn đồng ý với quy định sử dụng nội bộ của MYSP.
              </Text>
            </Stack>

            <Divider />

            {/* No size override on the copyright: `supporting` is already the
                theme's secondary tone, and dropping it another step is the one
                move on this screen that could fall under 4.5:1. The divider
                above it does the separating instead. */}
            <Stack direction="vertical" as="footer">
              <Text type="supporting">© MysP 2026. All right reserved.</Text>
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
 *
 * The tinted half is `variant="muted"`, a theme token, not a gradient. An
 * earlier revision mixed `accent -> muted -> background` through the Tailwind
 * bridge, which pulls the legacy shadcn lavender while every Astryx control on
 * the right half is drawn from theme-neutral: two accents on one screen. One
 * flat muted plane keeps the split readable and leaves exactly one accent in
 * the product.
 */
function BrandColumn() {
  return (
    <Section variant="muted" padding={8}>
      {/* Capped and centred: past ~520px the five value lines turn into a
          single long measure that nobody finishes reading. */}
      <Stack
        direction="vertical"
        gap={6}
        height="100%"
        vAlign="center"
        maxWidth={480}
        className="mx-auto"
      >
        <Stack direction="horizontal" gap={2} align="center" as="header">
          <Text weight="bold" size="lg">
            MYSP
          </Text>
          <Text type="supporting">Đăng bài tự động</Text>
        </Stack>

        <Stack direction="vertical" gap={2}>
          <Heading level={1} type="display-2" textWrap="balance">
            Bắt đầu ngay hôm nay
          </Heading>
          <Text type="supporting" textWrap="pretty">
            Công cụ soạn, duyệt và đăng bài đa nền tảng
          </Text>
        </Stack>

        {/* Hairline between the promise and the proof. It replaces a bigger
            gap, so the column keeps its rhythm without growing taller. */}
        <Divider />

        <Stack direction="vertical" gap={3} as="ul" className="list-none">
          {VALUE_POINTS.map((point) => (
            // The tick is decorative: the sentence beside it carries the whole
            // meaning, so Icon stays aria-hidden (its default). `accent`, not
            // `success` — nothing here has a pass/fail state, and a green tick
            // would put a second colour on a screen that has one.
            <Stack key={point} direction="horizontal" gap={2} align="start" as="li">
              <Icon icon="check" color="accent" size="sm" />
              <Text>{point}</Text>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Section>
  );
}

/**
 * The email/password block: visible, explained once, and inert.
 *
 * Showing it disabled rather than hiding it is a deliberate choice — operators
 * keep asking whether they can have a password account, and an empty space
 * answers nothing.
 *
 * The reason is stated EXACTLY ONCE, as visible text. An earlier revision also
 * passed it as `disabledMessage` on both fields and `tooltip` on the button;
 * Astryx turns each of those into an `aria-describedby` target, so a screen
 * reader read the same sentence four times in a row. Dropping them also drops
 * the aria-disabled escape hatch, which is the right trade here: the controls
 * become natively `disabled`, leave the tab order entirely, and there is
 * nothing left to "discover a reason" on. The sentence sits in the same labelled
 * region, immediately before them.
 */
function CredentialsPreview({ isSignUp }: { isSignUp: boolean }) {
  return (
    // `Card variant="muted"` is the whole visual argument: the block is
    // de-emphasised as one object, so the eye reads "not this one, the buttons
    // below" before it reads any of the labels. Loose in the column, five
    // greyed controls looked like a form that had failed to load.
    <Card variant="muted" padding={4}>
      <Stack direction="vertical" gap={3}>
        <Stack direction="horizontal" gap={2} align="center" hAlign="between" wrap="wrap">
          {/* h3 under the column's h2: the outline now runs h1 (brand) -> h2
              (auth) -> h3, so a screen-reader user can jump straight here. */}
          <Heading level={3}>
            {isSignUp ? "Đăng ký bằng email" : "Đăng nhập bằng email"}
          </Heading>
          <Badge variant="neutral" label="Sắp ra mắt" />
        </Stack>

        {/* The single source of truth for "why is this dead". */}
        <Text type="supporting">{COMING_SOON_REASON}</Text>

        <Stack direction="vertical" gap={2}>
          <TextInput
            label="Email"
            type="email"
            value=""
            placeholder="ban@congty.com"
            width="100%"
            isDisabled
          />
          <TextInput
            label={isSignUp ? "Mật khẩu mới" : "Mật khẩu"}
            type="password"
            value=""
            placeholder={isSignUp ? "Đặt mật khẩu mới" : "Mật khẩu của bạn"}
            width="100%"
            isDisabled
          />
          {isSignUp ? null : (
            <Stack direction="horizontal" hAlign="end">
              <Link href="#" isDisabled isStandalone>
                Quên mật khẩu
              </Link>
            </Stack>
          )}
        </Stack>

        <Button
          label={isSignUp ? "Đăng ký" : "Đăng nhập"}
          variant="secondary"
          size="lg"
          width="100%"
          isDisabled
        />
      </Stack>
    </Card>
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
