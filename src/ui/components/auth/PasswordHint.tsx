"use client";

import { Icon, Stack, Text, VisuallyHidden } from "@astryxdesign/core";

import { passwordHint } from "@/ui/schemas/password-auth.schema";

/**
 * ONE line under the new-password box saying what the password still needs.
 *
 * WHY ONE LINE AND NOT A TICK LIST: this used to be four rows, each reading
 * "Đạt" or "Chưa đạt". Four rows to carry one answer — the person had to read
 * all of them to find out what was missing, and on a phone they pushed the
 * submit button below the fold. Everything still missing is now named in a
 * single sentence built by `passwordHint` from the shared policy table.
 *
 * WHY IT IS NOT AN ERROR MESSAGE: nothing here turns red, and nothing waits for
 * blur. While rules are unmet the sentence is ordinary supporting text — the
 * person is mid-word, not wrong (core-auth-flows: thanh đo cập nhật khi gõ
 * nhưng không báo đỏ trước khi rời ô). The refusal that DOES turn red is the
 * server's, and it lands in the input's own status.
 *
 * A11Y: the sentence is plain text, deliberately NOT a live region — it changes
 * on every keystroke, and announcing it each time is unusable. Only the moment
 * the whole set is satisfied is announced, once, by the polite line below it.
 * The icon stays decorative: the sentence carries the whole meaning, so the
 * state is never in the colour or the glyph alone (core-accessibility §5).
 */
export function PasswordHint({ value }: { value: string }) {
  const { message, isReady } = passwordHint(value);

  return (
    <Stack direction="vertical" gap={1}>
      <Stack direction="horizontal" gap={2} align="start">
        <Icon
          icon={isReady ? "check" : "info"}
          size="sm"
          color={isReady ? "success" : "secondary"}
        />
        <Text type="supporting" color={isReady ? "primary" : "secondary"}>
          {message}
        </Text>
      </Stack>

      {/* VISUALLY HIDDEN, because the sentence above already says this on screen
          — printing it twice is what the tick list's separate summary line used
          to avoid by saying something the four rows did not. Always mounted and
          empty until it has something to say: a live region that appears
          together with its text is announced unreliably. */}
      <VisuallyHidden>
        <Text type="supporting" role="status" aria-live="polite">
          {isReady ? "Mật khẩu đã đạt đủ yêu cầu." : ""}
        </Text>
      </VisuallyHidden>
    </Stack>
  );
}
