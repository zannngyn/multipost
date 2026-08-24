import {
  Button,
  Card,
  Divider,
  Heading,
  Stack,
  StatusDot,
  Text,
} from "@astryxdesign/core";

import { cn } from "@/shared/utils";
import { Badge } from "@/ui/components/ui/badge";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { OperatorWaitingProps } from "./first-run.types";

export function OperatorWaitingCard({
  tenantName,
  role,
  signals,
  isReady,
  onCompose,
  onRefresh,
  isRefreshing,
}: OperatorWaitingProps) {
  const isEditor = role === "editor";
  const isViewer = role === "viewer";

  return (
    <Card padding={4} className="border-border bg-card shadow-xs">
      <Stack direction="vertical" gap={3}>
        {/* Header khối chờ */}
        <Stack direction="vertical" gap={1}>
          <Stack direction="horizontal" gap={2} align="center" justify="between" wrap="wrap">
            <Eyebrow>SỔ MẪU VẢI — KHÔNG GIAN LÀM VIỆC</Eyebrow>
            <Badge tone={isEditor ? "info" : "neutral"}>
              {isEditor ? "Biên tập viên (editor)" : "Chỉ xem (viewer)"}
            </Badge>
          </Stack>

          <Heading level={2} className="text-foreground text-lg font-semibold tracking-tight">
            {isReady
              ? `Xưởng ${tenantName} đã sẵn sàng làm việc`
              : `Xưởng ${tenantName} đang trong quá trình chuẩn bị`}
          </Heading>

          <Text type="supporting" className="text-xs text-muted-foreground leading-relaxed">
            {isEditor
              ? isReady
                ? "Quản trị viên đã kết nối dữ liệu kho hàng và trang Fanpage. Bạn có thể bắt đầu soạn bài và tạo nội dung ngay bây giờ."
                : "Bạn tham gia với vai trò Biên tập viên. Hệ thống đang chờ Quản trị viên (Chủ shop) kết nối nguồn ảnh Drive và Fanpage bán hàng."
              : "Bạn tham gia với vai trò Người xem (chỉ đọc). Bạn có thể theo dõi tiến độ cấu hình và số liệu hoạt động của xưởng."}
          </Text>
        </Stack>

        <Divider orientation="horizontal" />

        {/* Danh sách 3 tín hiệu trạng thái thời gian thực */}
        <Stack direction="vertical" gap={1.5}>
          <Eyebrow className="text-[10px] text-foreground-subtle">
            TRẠNG THÁI HỆ THỐNG HIỆN TẠI
          </Eyebrow>

          <Stack direction="vertical" gap={2}>
            {signals.map((signal, index) => {
              const isSignalReady = signal.state === "ready";

              return (
                <div
                  key={index}
                  data-slot="signal-row"
                  className={cn(
                    "flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg border",
                    isSignalReady
                      ? "bg-success/5 border-success/30 text-foreground"
                      : "bg-warning/5 border-warning/30 text-foreground",
                  )}
                >
                  <Stack direction="horizontal" gap={2} align="center">
                    <StatusDot
                      variant={isSignalReady ? "success" : "warning"}
                      label={isSignalReady ? "Đã sẵn sàng" : "Đang chờ admin"}
                      isPulsing={!isSignalReady}
                    />
                    <Text weight="medium" className="text-xs text-foreground">
                      {signal.label}
                    </Text>
                  </Stack>

                  <Stack direction="horizontal" gap={2} align="center">
                    {signal.detail ? (
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {signal.detail}
                      </span>
                    ) : null}

                    <Badge tone={isSignalReady ? "success" : "warning"}>
                      {isSignalReady ? "Sẵn sàng" : "Đang chờ"}
                    </Badge>
                  </Stack>
                </div>
              );
            })}
          </Stack>
        </Stack>

        <Divider orientation="horizontal" />

        {/* Hành động dưới cùng */}
        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap="wrap">
          {/* Nút làm mới trạng thái (dùng chung cho cả editor và viewer) */}
          <Button
            variant="secondary"
            label={isRefreshing ? "Đang kiểm tra..." : "Kiểm tra lại trạng thái"}
            isLoading={isRefreshing}
            onClick={onRefresh}
          />

          {/* Nếu đã sẵn sàng: Editor có nút soạn bài, Viewer tuyệt đối KHÔNG có nút soạn bài */}
          {isReady && isEditor && onCompose ? (
            <Button
              variant="primary"
              label="Bắt đầu soạn bài ngay →"
              onClick={onCompose}
            />
          ) : isReady && isViewer ? (
            <Text type="supporting" className="text-xs text-muted-foreground italic">
              Tài khoản chỉ xem — không có quyền đăng bài
            </Text>
          ) : null}
        </Stack>
      </Stack>
    </Card>
  );
}
