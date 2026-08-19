"use client";

import { useId } from "react";

/**
 * The panel shown while a sync is running.
 *
 * Deliberately WITHOUT a percentage, an ETA or a file counter: `POST
 * /api/catalog/sync` runs the whole read in one request and only answers when it
 * is done, so the browser has no progress to report. A bar that filled itself up
 * would be a made-up number (core-long-running-jobs: describe the step, never
 * invent a percentage), and "chặng 1/3" would be a guess — the server does not
 * say which stage it is in.
 *
 * What it can say honestly is what is happening and how long it may take.
 */
export function SyncRunningCard() {
  const headingId = `${useId()}-running`;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy="true"
      className="bg-card border-border space-y-2.5 rounded-xl border p-4"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="border-primary/30 border-t-primary size-4 shrink-0 rounded-full border-2 motion-safe:animate-spin"
        />
        <h2 id={headingId} className="text-sm font-semibold">
          Đang đọc Drive và Sheet
        </h2>
      </div>

      {/* Indeterminate on purpose: it pulses to show work, it does not fill. */}
      <span
        aria-hidden="true"
        className="bg-muted flex h-1.5 w-full overflow-hidden rounded-full"
      >
        <span className="bg-primary/60 h-full w-full motion-safe:animate-pulse" />
      </span>

      <p className="text-muted-foreground text-sm">
        Chưa có số liệu cho tới khi lần chạy kết thúc — hệ thống không báo được tiến độ giữa chừng.
        Thư mục lớn có thể mất vài phút. Kết quả sẽ hiện ngay bên dưới khi xong.
      </p>
    </section>
  );
}
