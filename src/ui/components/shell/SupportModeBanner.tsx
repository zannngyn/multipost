"use client";

import { Banner, Button } from "@astryxdesign/core";

import { useEndSupportSession } from "@/ui/hooks/usePlatformTenants";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useNowMs } from "@/ui/hooks/useNowMs";

/**
 * The reminder that never goes away while MYSP staff are inside a customer's
 * company (M3.3).
 *
 * WHY IT IS PERMANENT: every screen below looks exactly like the operator's own
 * company. Without a standing marker, someone reads a customer's job log,
 * forgets whose it is, and answers a question about the wrong shop. The banner
 * is the difference between "đang xem dữ liệu khách" being obvious and being
 * something you have to remember.
 *
 * It sits ABOVE the content and pushes it down rather than floating over it —
 * covering content is how a banner gets dismissed mentally
 * (core-feedback-states: làm mới nền không được che nội dung).
 *
 * `role="status"` (polite), not `alert`: nothing is wrong and nothing is
 * interrupting — it is a standing fact about the session.
 */

/** The countdown re-renders once a minute; seconds would be noise. */
const TICK_MS = 30_000;

export function SupportModeBanner() {
  const { supportSession, isSupportMode } = useActiveTenant();
  const end = useEndSupportSession();
  const nowMs = useNowMs(TICK_MS);

  // Not in support mode — and an expired session already reads as "not in"
  // (see `useActiveTenant`), so a stale cookie cannot pin this banner up.
  if (!isSupportMode || supportSession === null) return null;

  const remaining = formatRemaining(supportSession.expiresAt, nowMs);

  return (
    <Banner
      role="status"
      status="warning"
      title={`Đang hỗ trợ ${supportSession.tenantName} — chỉ đọc`}
      description={`Bạn đang xem dữ liệu của khách, không phải công ty của bạn. Mọi thao tác ghi đều bị từ chối. Phiên hỗ trợ ${remaining}.`}
      endContent={
        <Button
          variant="secondary"
          size="sm"
          label={end.isPending ? "Đang thoát…" : "Thoát hỗ trợ"}
          isLoading={end.isPending}
          isDisabled={end.isPending}
          onClick={() => {
            end.reset();
            end.mutate();
          }}
        />
      }
    />
  );
}

/**
 * "còn 42 phút" / "còn dưới 1 phút" / "đã hết hạn".
 *
 * Deliberately coarse: a per-second countdown on a permanent banner is a
 * distraction, and the exact second is never the decision — "sắp hết" is.
 */
export function formatRemaining(expiresAt: string, nowMs: number): string {
  const expiresAtMs = Date.parse(expiresAt);
  // An unreadable expiry must not print "còn NaN phút"; saying nothing precise
  // is better than saying something wrong on a banner about someone else's data.
  if (Number.isNaN(expiresAtMs)) return "sẽ tự hết hạn";

  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) return "đã hết hạn — hãy thoát rồi vào lại nếu còn cần";

  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return "còn dưới 1 phút";
  if (minutes < 60) return `còn ${minutes} phút`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `còn ${hours} giờ` : `còn ${hours} giờ ${rest} phút`;
}
