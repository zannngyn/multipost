"use client";

import { Heading, ProgressBar, Section, Stack, Text } from "@astryxdesign/core";
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
 * The bar is `isIndeterminate` for exactly that reason: it shows that work is
 * happening and refuses to claim how much is left.
 *
 * What it can say honestly is what is happening and how long it may take.
 */
export function SyncRunningCard() {
  const headingId = `${useId()}-running`;

  return (
    <Section variant="muted" padding={4} aria-labelledby={headingId} aria-busy="true">
      <Stack direction="vertical" gap={2}>
        <Heading level={2} id={headingId}>
          Đang đọc Drive và Sheet
        </Heading>

        <ProgressBar label="Đang chạy đồng bộ" isLabelHidden isIndeterminate />

        <Text type="supporting">
          Chưa có số liệu cho tới khi lần chạy kết thúc — hệ thống không báo được tiến độ giữa
          chừng. Thư mục lớn có thể mất vài phút. Kết quả sẽ hiện ngay bên dưới khi xong.
        </Text>
      </Stack>
    </Section>
  );
}
