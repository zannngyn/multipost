"use client";

import {
  Badge,
  Banner,
  Button,
  Grid,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  SelectableCard,
  Skeleton,
  Stack,
  Text,
} from "@astryxdesign/core";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { PresetSwatch } from "@/ui/components/platform/PresetSwatch";
import { useAppearance, useUpdateAppearance } from "@/ui/hooks/useAppearance";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useMe } from "@/ui/hooks/useMe";
import {
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE_PRESET_ID,
  appearanceBlockReason,
  canChangeAppearance,
  type AppearancePresetId,
} from "@/ui/schemas/appearance.schema";
import { platformRoleLabel } from "@/ui/schemas/platform.schema";

/**
 * "Màu giao diện" (M3.4) — the one screen that repaints the product.
 *
 * NOT tenant-scoped, like every `/platform` screen: one value governs every
 * company at once, and the person setting it may hold no membership anywhere.
 *
 * Two audiences: `support` reads which colour is on, `super_admin` changes it.
 * The reason is said ONCE at the top instead of leaving a grid of dead cards
 * (core-auth-session §ẩn vs vô hiệu hoá) — but the cards stay readable, because
 * "what is the product wearing" is a legitimate thing for support to look up.
 *
 * WHY A SAVE BUTTON AND NOT SAVE-ON-CLICK: a click here changes what every
 * customer sees on their next page load. That deserves a second, deliberate
 * action — and it lets the operator compare two swatches without repainting the
 * product twice on the way.
 *
 * The four states:
 *   loading — swatch-shaped skeletons, delayed 300ms
 *   data    — six cards, the live one badged
 *   empty   — impossible: the preset table is code, never an empty list
 *   error   — read failure and save failure are reported separately, because
 *             one means "cannot show you the current colour" and the other
 *             means "your change did not land"
 */
export function AppearanceScreen() {
  const me = useMe();
  const platformRole = me.data?.account?.platformRole ?? null;
  const canChange = canChangeAppearance(platformRole);

  const appearance = useAppearance();
  const update = useUpdateAppearance();

  /** Null = follow the server. Set = the operator picked something else. */
  const [picked, setPicked] = useState<AppearancePresetId | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const livePresetId = appearance.data?.presetId ?? null;
  const selectedId = picked ?? livePresetId;
  const hasUnsavedPick = picked !== null && picked !== livePresetId;

  const isFirstLoad = appearance.isPending && appearance.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const blockReason = appearanceBlockReason(platformRole);

  function handlePick(presetId: AppearancePresetId) {
    setOutcome(null);
    update.reset();
    setPicked(presetId);
  }

  function handleSave() {
    if (!hasUnsavedPick || picked === null) return;

    setOutcome(null);
    update.reset();
    update.mutate(picked, {
      onSuccess: (result) => {
        const preset = APPEARANCE_PRESETS.find((candidate) => candidate.id === result.presetId);
        setPicked(null);
        setOutcome(
          result.already
            ? `Giao diện đã đang dùng ${preset?.label ?? result.presetId} — không có gì thay đổi.`
            : `Đã đổi màu giao diện sang ${preset?.label ?? result.presetId}. Mọi công ty sẽ thấy màu mới ở lần tải trang tiếp theo.`,
        );
      },
    });
  }

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <HStack gap={2} align="center" wrap="wrap">
                <Heading level={1}>Màu giao diện</Heading>
                <Badge
                  variant={canChange ? "purple" : "neutral"}
                  label={platformRoleLabel(platformRole)}
                />
              </HStack>
              <Text type="supporting">
                Màu chủ đạo của toàn bộ MYSP. Đây là cài đặt của nền tảng, không phải của một công
                ty — đổi ở đây là đổi cho tất cả khách hàng cùng lúc.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label={appearance.isFetching ? "Đang tải…" : "Tải lại"}
                isDisabled={appearance.isFetching}
                onClick={() => void appearance.refetch()}
              />
              {canChange ? (
                <Button
                  variant="primary"
                  size="sm"
                  label={update.isPending ? "Đang lưu…" : "Lưu màu đã chọn"}
                  isDisabled={!hasUnsavedPick || update.isPending}
                  onClick={handleSave}
                />
              ) : null}
              {/* Said once, at the top, instead of six cards that do nothing. */}
              {blockReason ? <Text type="supporting">{blockReason}</Text> : null}
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {/* Always mounted, empty most of the time: a live region that
                appears together with its text is announced unreliably
                (web-feedback-states §4). */}
            <Stack
              direction="vertical"
              role="status"
              aria-live="polite"
              paddingInline={4}
              paddingBlock={outcome ? 3 : 0}
            >
              {outcome ? (
                <Banner
                  status="success"
                  isDismissable
                  onDismiss={() => setOutcome(null)}
                  title="Đã lưu thay đổi"
                  description={outcome}
                />
              ) : null}
            </Stack>

            {/* A refused save is about the change, not about the screen. */}
            {update.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ApiErrorNotice error={update.error} operation="platform" />
              </Stack>
            ) : null}

            <Stack direction="vertical" gap={3} padding={4}>
              <Stack direction="vertical" gap={1}>
                <Heading level={2}>Bộ màu</Heading>
                <Text type="supporting">
                  Mỗi bộ đổi cả nền, thẻ, viền, màu chữ và màu hành động. Độ sáng của từng lớp giữ
                  nguyên nên không bộ nào làm chữ khó đọc đi — mọi cặp chữ/nền đều được đo, thấp
                  nhất 4.5:1. Bốn màu trạng thái (lỗi, cảnh báo, thành công, thông tin) không đổi.
                </Text>
              </Stack>

              {appearance.isError ? (
                <ApiErrorNotice
                  error={appearance.error}
                  operation="platform"
                  onRetry={() => void appearance.refetch()}
                />
              ) : showSkeleton ? (
                <AppearanceGridSkeleton />
              ) : appearance.data ? (
                <>
                  <Grid columns={{ minWidth: 240, max: 3 }} gap={3}>
                    {APPEARANCE_PRESETS.map((preset) => {
                      const isLive = preset.id === livePresetId;
                      const isSelected = preset.id === selectedId;

                      return (
                        <SelectableCard
                          key={preset.id}
                          label={`Bộ màu ${preset.label}${isLive ? " — đang dùng" : ""}`}
                          isSelected={isSelected}
                          isDisabled={!canChange || update.isPending}
                          onChange={() => handlePick(preset.id)}
                          padding={3}
                        >
                          <Stack direction="vertical" gap={2}>
                            <PresetSwatch presetId={preset.id} />
                            <Stack direction="vertical" gap={1}>
                              <HStack gap={2} align="center" wrap="wrap">
                                <Text weight="semibold">{preset.label}</Text>
                                {/* The badge, not the border, is what says
                                    "live": a selection ring and a live marker
                                    are two different facts and must not share
                                    one signal. */}
                                {isLive ? <Badge variant="green" label="Đang dùng" /> : null}
                                {isSelected && !isLive ? (
                                  <Badge variant="orange" label="Chưa lưu" />
                                ) : null}
                              </HStack>
                              <Text type="supporting">{preset.description}</Text>
                            </Stack>
                          </Stack>
                        </SelectableCard>
                      );
                    })}
                  </Grid>

                  {canChange ? (
                    <HStack gap={3} align="center" wrap="wrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        label="Về bộ mặc định"
                        isDisabled={
                          update.isPending ||
                          (livePresetId === DEFAULT_APPEARANCE_PRESET_ID && !hasUnsavedPick)
                        }
                        onClick={() => handlePick(DEFAULT_APPEARANCE_PRESET_ID)}
                      />
                      <Text type="supporting">
                        Mặc định là Sơn mài — nền than ấm, nhấn vàng nghệ. Chàm là bản gốc của
                        thiết kế đã duyệt, vẫn chọn được trong danh sách.
                      </Text>
                    </HStack>
                  ) : null}
                </>
              ) : null}
            </Stack>
          </Stack>
        </LayoutContent>
      }
    />
  );
}

/**
 * Same grid, same card shape: a skeleton that does not match the thing it
 * stands in for makes the page jump when the data lands.
 */
function AppearanceGridSkeleton() {
  return (
    <Grid columns={{ minWidth: 240, max: 3 }} gap={3} aria-hidden="true">
      {APPEARANCE_PRESETS.map((preset) => (
        <Stack key={preset.id} direction="vertical" gap={2} padding={3}>
          <Skeleton height={48} />
          <Skeleton width="50%" height={16} />
          <Skeleton height={14} />
        </Stack>
      ))}
    </Grid>
  );
}
