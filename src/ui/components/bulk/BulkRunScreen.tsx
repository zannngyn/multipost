"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { BulkCodesField } from "@/ui/components/bulk/BulkCodesField";
import { BulkProgressTable } from "@/ui/components/bulk/BulkProgressTable";
import { ChannelGroupPicker } from "@/ui/components/compose/ChannelGroupPicker";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Button } from "@/ui/components/ui/button";
import { Textarea } from "@/ui/components/ui/textarea";
import { useBulkRun } from "@/ui/hooks/useBulkRun";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import {
  BULK_CAPTION_MODES,
  BULK_CAPTION_MODE_LABELS,
  BulkRunFormSchema,
  CAPTION_TEMPLATE_VARIABLES,
  findUnknownTemplateVariables,
  parseBulkCodes,
  renderCaptionTemplate,
  type BulkRunFormValues,
} from "@/ui/schemas/bulk.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";

/**
 * "Chạy hàng loạt" (E10.5): component -> hook -> service -> internal API.
 *
 * The order of the screen is the order of the business rules (rule 1): the
 * codes, then the channels, then the caption, then "Chạy". Each code goes
 * through compose (stock gate first) before any caption is asked for.
 *
 * Four states:
 *   loading — the channel groups skeleton (inside <ChannelGroupPicker>)
 *   data    — the form; once a run starts, the per-code progress table
 *   empty   — no channel group yet (picker) / no run yet (progress block)
 *   error   — groups error in the picker; per-code failures in the table, with
 *             a summary that separates "bỏ qua" from "lỗi"
 *
 * Business rule 2: nothing here can show or send stock/price. The manual
 * template only knows {code} and {name}; the AI path sends the whitelisted
 * `content` object returned by compose.
 */
export function BulkRunScreen() {
  // Phase 1 is single-tenant in the UI; E10.4 will read it from the session.
  const tenantId = DEMO_TENANT_ID;
  const codesId = useId();
  const templateId = useId();
  const captionModeId = useId();

  const groups = useChannelGroups(tenantId);
  const run = useBulkRun();
  const schedule = useScheduleChoice();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [channelError, setChannelError] = useState<string | null>(null);
  /** Whether the run in the table was scheduled — decides where its link points. */
  const [ranScheduled, setRanScheduled] = useState(false);

  const form = useForm<BulkRunFormValues>({
    resolver: zodResolver(BulkRunFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      tenantId,
      codesText: "",
      captionMode: "ai",
      captionTemplate: "",
    },
  });

  const codesText = useWatch({ control: form.control, name: "codesText" }) ?? "";
  const captionMode = useWatch({ control: form.control, name: "captionMode" }) ?? "ai";
  const captionTemplate = useWatch({ control: form.control, name: "captionTemplate" }) ?? "";

  const parsed = useMemo(() => parseBulkCodes(codesText), [codesText]);
  const unknownVariables = useMemo(
    () => findUnknownTemplateVariables(captionTemplate),
    [captionTemplate],
  );

  const selectedIds = useMemo(() => [...selected], [selected]);
  const groupItems = groups.data?.groups ?? [];
  const { phase, summary, rows, isRunning } = run;

  // Focus the result summary when the run ends, instead of letting focus sit on
  // a now-disabled button (web-bulk-actions rule 5).
  useEffect(() => {
    if (phase === "finished") summaryRef.current?.focus();
  }, [phase]);

  function toggleChannel(channelId: string, checked: boolean) {
    setChannelError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(channelId);
      else next.delete(channelId);
      return next;
    });
  }

  function toggleGroup(channelIds: readonly string[], checked: boolean) {
    setChannelError(null);
    setSelected((current) => {
      const next = new Set(current);
      for (const channelId of channelIds) {
        if (checked) next.add(channelId);
        else next.delete(channelId);
      }
      return next;
    });
  }

  function handleSubmit(values: BulkRunFormValues) {
    // --- Edge case first: channels are not part of the zod schema ----------
    if (selectedIds.length === 0) {
      setChannelError("Chọn ít nhất một kênh để đăng.");
      return;
    }
    setChannelError(null);

    // Validated against the clock at submit time; its message lands on the field.
    const resolved = schedule.resolve();
    if (!resolved.ok) return;
    setRanScheduled(resolved.scheduledAt !== null);

    void run.start({
      tenantId: values.tenantId,
      codes: parseBulkCodes(values.codesText).codes.map((item) => item.code),
      channelIds: selectedIds,
      captionMode: values.captionMode,
      captionTemplate: values.captionTemplate,
      scheduledAt: resolved.scheduledAt,
    });
  }

  return (
    <section className="space-y-6" aria-labelledby="bulk-heading">
      <header className="space-y-1">
        <h1 id="bulk-heading" className="text-2xl font-semibold tracking-tight">
          Chạy hàng loạt
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Dán danh sách mã, chọn kênh, rồi chạy tuần tự từng mã. Mã hết hàng hoặc thiếu ảnh bị bỏ
          qua kèm lý do — cả lô vẫn chạy tiếp. Trang này chạy trong trình duyệt: đừng đóng tab giữa
          chừng, các lô đã tạo thì vẫn chạy tiếp trên máy chủ.
        </p>
        <p className="text-muted-foreground max-w-prose text-sm">
          Màn này chỉ chạy <strong className="text-foreground font-medium">bài ảnh</strong>. Bài
          video cần chọn đích đăng và kiểm thông số từng clip, nên làm ở màn{" "}
          <Link href="/compose" className="underline underline-offset-4">
            Soạn bài
          </Link>
          .
        </p>
      </header>

      <form noValidate className="space-y-6" onSubmit={form.handleSubmit(handleSubmit)}>
        <BulkCodesField
          id={codesId}
          registration={form.register("codesText")}
          parsed={parsed}
          error={form.formState.errors.codesText?.message}
          disabled={isRunning}
        />

        <div className="space-y-2">
          <h2 className="text-sm font-medium">Chọn kênh (áp dụng cho mọi mã)</h2>
          <ChannelGroupPicker
            groups={groupItems}
            selected={selected}
            onToggleChannel={toggleChannel}
            onToggleGroup={toggleGroup}
            loading={groups.isPending && groups.fetchStatus === "fetching"}
            error={groups.isError ? groups.error : undefined}
            onRetry={() => void groups.refetch()}
            disabled={isRunning}
          />
          {groupItems.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Đã chọn {selectedIds.length} kênh · mỗi mã sẽ tạo {selectedIds.length} bài.{" "}
              <Link href="/channels" className="underline underline-offset-4">
                Quản lý nhóm kênh
              </Link>
            </p>
          ) : null}
          {channelError ? (
            <p role="alert" className="text-destructive text-sm">
              {channelError}
            </p>
          ) : null}
        </div>

        <fieldset className="space-y-3" aria-describedby={`${captionModeId}-hint`}>
          <legend className="text-sm font-medium">Caption</legend>
          <p id={`${captionModeId}-hint`} className="text-muted-foreground text-xs">
            Caption chỉ dùng tên, mô tả, chủng loại, mùa vụ của sản phẩm. Không có biến giá hay tồn
            kho — thông tin đó không bao giờ đi vào bài đăng.
          </p>

          {BULK_CAPTION_MODES.map((mode) => (
            <label key={mode} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                value={mode}
                className="accent-primary mt-0.5 size-4"
                disabled={isRunning}
                {...form.register("captionMode")}
              />
              <span>
                {BULK_CAPTION_MODE_LABELS[mode]}
                <span className="text-muted-foreground block text-xs">
                  {mode === "ai"
                    ? "Gọi AI một lần cho mỗi mã. Chậm hơn và cần cấu hình khoá AI; mã nào AI viết hỏng thì báo lỗi ở dòng đó."
                    : "Một mẫu chung, thay {code} và {name} theo từng mã. Không cần AI."}
                </span>
              </span>
            </label>
          ))}

          {captionMode === "template" ? (
            <div className="space-y-1.5">
              <label htmlFor={templateId} className="text-sm font-medium">
                Mẫu caption dùng chung
              </label>
              <Textarea
                id={templateId}
                {...form.register("captionTemplate")}
                rows={5}
                disabled={isRunning}
                aria-invalid={form.formState.errors.captionTemplate ? true : undefined}
                aria-describedby={`${templateId}-hint`}
                placeholder={"{name} — mã {code}\nInbox để được tư vấn size."}
              />
              <p id={`${templateId}-hint`} className="text-muted-foreground text-xs">
                Biến dùng được: {CAPTION_TEMPLATE_VARIABLES.map((name) => `{${name}}`).join(", ")}.
                Các biến khác giữ nguyên chữ, không được thay.
              </p>
              {form.formState.errors.captionTemplate ? (
                <p role="alert" className="text-destructive text-sm">
                  {form.formState.errors.captionTemplate.message}
                </p>
              ) : null}
              {unknownVariables.length > 0 ? (
                <p role="alert" className="text-warning-foreground text-xs">
                  Không nhận ra biến {unknownVariables.map((name) => `{${name}}`).join(", ")} — sẽ
                  giữ nguyên chữ trong caption. Chỉ có {CAPTION_TEMPLATE_VARIABLES.map((n) => `{${n}}`).join(", ")}{" "}
                  được thay.
                </p>
              ) : null}
              {captionTemplate.trim().length > 0 && parsed.codes.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs">
                    Xem thử với mã {parsed.codes[0].code} (tên sản phẩm lấy từ dữ liệu khi chạy):
                  </p>
                  <pre className="bg-muted/40 max-h-48 overflow-auto rounded-lg border p-3 text-sm break-words whitespace-pre-wrap">
                    {renderCaptionTemplate(captionTemplate, {
                      code: parsed.codes[0].code,
                      name: "(tên sản phẩm)",
                    })}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <SchedulePicker
          choice={schedule}
          disabled={isRunning}
          scopeNote="Áp dụng cho mọi mã và mọi kênh trong lượt chạy này. Các bài vẫn được đăng giãn cách theo cấu hình kênh, không lên cùng lúc."
        />

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button type="submit" disabled={isRunning}>
            {isRunning
              ? "Đang chạy…"
              : schedule.mode === "scheduled"
                ? `Hẹn giờ ${parsed.codes.length} mã`
                : `Chạy ${parsed.codes.length} mã`}
          </Button>
          {isRunning ? (
            <Button type="button" variant="destructive" onClick={run.stop} disabled={phase === "stopping"}>
              {phase === "stopping" ? "Đang dừng…" : "Dừng"}
            </Button>
          ) : null}
          {phase === "finished" ? (
            <Button type="button" variant="ghost" onClick={run.reset}>
              Xoá kết quả để chạy lượt mới
            </Button>
          ) : null}
        </div>
      </form>

      <section aria-labelledby="bulk-progress-heading" className="space-y-3">
        <h2 id="bulk-progress-heading" className="text-lg font-semibold">
          Tiến độ
        </h2>

        {rows.length === 0 ? (
          <EmptyState
            kind="idle"
            title="Chưa chạy lượt nào"
            description="Nhập mã, chọn kênh rồi bấm “Chạy”. Bảng này sẽ hiện trạng thái của từng mã ngay khi bắt đầu."
          />
        ) : (
          <>
            <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
              Đã xử lý {summary.processed}/{summary.total} mã
              {isRunning ? " — đang chạy, đừng đóng tab." : "."}
            </p>

            <div
              ref={summaryRef}
              tabIndex={-1}
              role={phase === "finished" ? "alert" : undefined}
              className="bg-muted/30 rounded-xl border p-4 text-sm outline-none"
            >
              <p className="font-medium">
                {phase === "finished"
                  ? `Xong: ${summary.done} thành công · ${summary.skipped} bỏ qua · ${summary.failed} lỗi${
                      summary.cancelled > 0 ? ` · ${summary.cancelled} đã dừng` : ""
                    }.`
                  : `Đang chạy: ${summary.done} thành công · ${summary.skipped} bỏ qua · ${summary.failed} lỗi.`}
              </p>
              <p className="text-muted-foreground mt-1">
                {summary.cancelled > 0
                  ? `${summary.cancelled} mã chưa chạy nên không bị ảnh hưởng gì. `
                  : ""}
                {ranScheduled
                  ? "Các lô đã tạo đang chờ tới giờ hẹn — đổi giờ hoặc huỷ ở "
                  : "Các lô đã tạo chạy tiếp trên máy chủ kể cả khi bạn rời trang — xem ở "}
                {ranScheduled ? (
                  <Link href="/scheduled" className="underline underline-offset-4">
                    Bài đã hẹn
                  </Link>
                ) : (
                  <Link href="/jobs" className="underline underline-offset-4">
                    Nhật ký đăng bài
                  </Link>
                )}
                .
              </p>
            </div>

            <BulkProgressTable rows={rows} />
          </>
        )}
      </section>
    </section>
  );
}
