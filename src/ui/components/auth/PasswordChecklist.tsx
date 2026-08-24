"use client";

import { Icon, Stack, Text } from "@astryxdesign/core";

import { isPasswordReady, passwordChecklist } from "@/ui/schemas/password-auth.schema";

/**
 * The four password rules, ticking as the operator types.
 *
 * WHY IT IS NOT AN ERROR MESSAGE: nothing here turns red, and nothing waits for
 * blur. A rule that is not met yet reads "Chưa đạt", in the ordinary supporting
 * colour — the person is mid-word, not wrong (core-auth-flows: thanh đo cập
 * nhật khi gõ nhưng không báo đỏ trước khi rời ô). The refusal that DOES turn
 * red is the server's, and it lands under the input.
 *
 * A11Y: the state of each rule is in the TEXT ("Đạt" / "Chưa đạt"), never in the
 * tick alone (core-accessibility §5 — không truyền tin chỉ bằng màu), and the
 * icon stays decorative. The list itself is not a live region: announcing four
 * lines on every keystroke is unusable. Only the moment the whole set is
 * satisfied is announced, once, by the polite line at the bottom.
 */
export function PasswordChecklist({ value }: { value: string }) {
  const items = passwordChecklist(value);
  const isReady = isPasswordReady(value);

  return (
    <Stack direction="vertical" gap={1}>
      <Stack direction="vertical" gap={0.5} as="ul" className="list-none">
        {items.map((item) => (
          <Stack key={item.rule} direction="horizontal" gap={2} align="center" as="li">
            <Icon
              icon={item.isMet ? "check" : "close"}
              size="sm"
              color={item.isMet ? "success" : "secondary"}
            />
            <Text type="supporting" color={item.isMet ? "primary" : "secondary"}>
              {item.isMet ? "Đạt" : "Chưa đạt"}: {item.label}
            </Text>
          </Stack>
        ))}
      </Stack>

      {/* Always mounted, empty until it has something to say: a live region that
          appears together with its text is announced unreliably. */}
      <Text type="supporting" role="status" aria-live="polite">
        {isReady ? "Mật khẩu đã đạt đủ yêu cầu." : ""}
      </Text>
    </Stack>
  );
}
