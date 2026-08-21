"use client";

import {
  Banner,
  Button,
  CodeBlock,
  Divider,
  EmptyState,
  Field,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Link,
  RadioList,
  RadioListItem,
  Stack,
  StackItem,
  Text,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { BulkCodesField } from "@/ui/components/bulk/BulkCodesField";
import { BulkProgressTable } from "@/ui/components/bulk/BulkProgressTable";
import { ChannelGroupPicker } from "@/ui/components/compose/ChannelGroupPicker";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Textarea } from "@/ui/components/ui/textarea";
import {
  useBulkRun,
  type BulkRunPhase,
  type BulkRunRow,
  type BulkRunSummary,
} from "@/ui/hooks/useBulkRun";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import {
  BULK_CAPTION_MODE_LABELS,
  BulkRunFormSchema,
  CAPTION_TEMPLATE_VARIABLES,
  findUnknownTemplateVariables,
  parseBulkCodes,
  renderCaptionTemplate,
  type BulkRunFormValues,
} from "@/ui/schemas/bulk.schema";

/**
 * "Chạy hàng loạt" (E10.5): component -> hook -> service -> internal API.
 *
 * Frame (`astryx docs layout`, tracker archetype): the header names the screen
 * and its one warning; the content region carries the form, then the per-code
 * result rows edge-to-edge. The rows are the reason this screen exists, so they
 * get the full width rather than a centred reading column.
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
  const codesId = useId();
  const templateId = useId();
  const captionHintId = `${templateId}-mode-hint`;

  const groups = useChannelGroups();
  const run = useBulkRun();
  const schedule = useScheduleChoice();
  const summaryRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [channelError, setChannelError] = useState<string | null>(null);
  /** Whether the run in the table was scheduled — decides where its link points. */
  const [ranScheduled, setRanScheduled] = useState(false);

  const form = useForm<BulkRunFormValues>({
    resolver: zodResolver(BulkRunFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
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

  // Support mode is read-only (M3.3): a bulk run publishes to the customer's
  // Pages, so the trigger goes off with its reason attached.
  const gate = writeGate(useReadOnlyReason(), isRunning);

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
      codes: parseBulkCodes(values.codesText).codes.map((item) => item.code),
      channelIds: selectedIds,
      captionMode: values.captionMode,
      captionTemplate: values.captionTemplate,
      scheduledAt: resolved.scheduledAt,
    });
  }

  const runLabel = isRunning
    ? "Đang chạy…"
    : schedule.mode === "scheduled"
      ? `Hẹn giờ ${parsed.codes.length} mã`
      : `Chạy ${parsed.codes.length} mã`;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={1} padding={4}>
            <Heading level={1}>Chạy hàng loạt</Heading>
            <Text type="supporting">
              Dán danh sách mã, chọn kênh, rồi chạy tuần tự từng mã. Mã hết hàng hoặc thiếu ảnh bị
              bỏ qua kèm lý do — cả lô vẫn chạy tiếp. Vòng lặp chạy trong trình duyệt: đừng đóng tab
              giữa chừng, các lô đã tạo thì vẫn chạy tiếp trên máy chủ.
            </Text>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" gap={0}>
            {/* Said once, at the top, before any field is filled in: finding out
                after typing forty codes that this screen cannot post video is
                the expensive version of this sentence. */}
            <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
              <Banner
                status="info"
                title="Màn này chỉ chạy bài ảnh"
                description="Bài video cần chọn đích đăng và kiểm thông số từng clip."
                endContent={
                  <Button variant="secondary" size="sm" label="Mở màn Soạn bài" href="/compose" />
                }
              />
            </Stack>

            {/* A real <form>: `noValidate` + submit belong to the element, not
                to a layout component. Everything inside it is Astryx. */}
            <form noValidate onSubmit={form.handleSubmit(handleSubmit)}>
              <Stack
                direction="vertical"
                gap={5}
                paddingInline={4}
                paddingBlock={3}
                maxWidth={880}
              >
                <BulkCodesField
                  id={codesId}
                  registration={form.register("codesText")}
                  parsed={parsed}
                  error={form.formState.errors.codesText?.message}
                  disabled={isRunning}
                />

                <Stack direction="vertical" gap={2}>
                  <Heading level={2}>
                    Chọn kênh
                  </Heading>
                  <Text type="supporting">Áp dụng cho mọi mã trong lượt chạy này.</Text>

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
                    <Text type="supporting">
                      Đã chọn {selectedIds.length} kênh · mỗi mã sẽ tạo {selectedIds.length} bài.{" "}
                      <Link href="/channels/groups">Quản lý nhóm kênh</Link>
                    </Text>
                  ) : null}

                  {/* Not part of the zod schema, so it has no field to sit under:
                      it belongs to the picker above it and is announced. */}
                  {channelError ? (
                    <Banner role="alert" status="error" title={channelError} />
                  ) : null}
                </Stack>

                <Stack direction="vertical" gap={3}>
                  <Stack direction="vertical" gap={1}>
                    <Heading level={2}>
                      Caption
                    </Heading>
                    <Text id={captionHintId} type="supporting">
                      Caption chỉ dùng tên, mô tả, chủng loại, mùa vụ của sản phẩm. Không có biến giá
                      hay tồn kho — thông tin đó không bao giờ đi vào bài đăng.
                    </Text>
                  </Stack>

                  {/* Astryx RadioList takes `value`/`onChange` rather than a
                      ref, which is the one case core-form-architecture allows a
                      controlled field — so it goes through `Controller`, like
                      every other Astryx input in this codebase. The form keeps
                      the value AND the validation schedule: `mode: "onSubmit"`
                      plus `reValidateMode: "onChange"` still decide when the
                      resolver runs. */}
                  <Controller
                    control={form.control}
                    name="captionMode"
                    render={({ field, fieldState }) => (
                      <RadioList
                        label="Cách viết caption"
                        isLabelHidden
                        aria-describedby={captionHintId}
                        htmlName={field.name}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        isDisabled={isRunning}
                        status={
                          fieldState.error
                            ? { type: "error", message: fieldState.error.message }
                            : undefined
                        }
                      >
                        <RadioListItem
                          value="ai"
                          label={BULK_CAPTION_MODE_LABELS.ai}
                          description="Gọi AI một lần cho mỗi mã. Chậm hơn và cần cấu hình khoá AI; mã nào AI viết hỏng thì báo lỗi ở dòng đó."
                        />
                        <RadioListItem
                          value="template"
                          label={BULK_CAPTION_MODE_LABELS.template}
                          description="Một mẫu chung, thay {code} và {name} theo từng mã. Không cần AI."
                        />
                      </RadioList>
                    )}
                  />

                  {captionMode === "template" ? (
                    <Stack direction="vertical" gap={2}>
                      <Field
                        label="Mẫu caption dùng chung"
                        inputID={templateId}
                        descriptionID={`${templateId}-hint`}
                        description={`Biến dùng được: ${CAPTION_TEMPLATE_VARIABLES.map((name) => `{${name}}`).join(", ")}. Các biến khác giữ nguyên chữ, không được thay.`}
                        isDisabled={isRunning}
                        statusVariant="detached"
                        status={
                          form.formState.errors.captionTemplate
                            ? {
                                type: "error",
                                message: form.formState.errors.captionTemplate.message,
                                messageID: `${templateId}-error`,
                              }
                            : undefined
                        }
                      >
                        {/* Repo textarea: bound with react-hook-form `register()`,
                            which the controlled Astryx TextArea cannot take. */}
                        <Textarea
                          id={templateId}
                          {...form.register("captionTemplate")}
                          rows={5}
                          disabled={isRunning}
                          aria-invalid={form.formState.errors.captionTemplate ? true : undefined}
                          aria-describedby={`${templateId}-hint`}
                          placeholder={"{name} — mã {code}\nInbox để được tư vấn size."}
                        />
                      </Field>

                      {unknownVariables.length > 0 ? (
                        <Banner
                          role="alert"
                          status="warning"
                          title={`Không nhận ra biến ${unknownVariables.map((name) => `{${name}}`).join(", ")}`}
                          description={`Những biến này sẽ giữ nguyên chữ trong caption. Chỉ ${CAPTION_TEMPLATE_VARIABLES.map((n) => `{${n}}`).join(", ")} được thay.`}
                        />
                      ) : null}

                      {captionTemplate.trim().length > 0 && parsed.codes.length > 0 ? (
                        <Stack direction="vertical" gap={1}>
                          <Text type="supporting">
                            Xem thử với mã {parsed.codes[0].code} (tên sản phẩm lấy từ dữ liệu khi
                            chạy):
                          </Text>
                          <CodeBlock
                            language="text"
                            isWrapped
                            hasCopyButton={false}
                            maxHeight={192}
                            code={renderCaptionTemplate(captionTemplate, {
                              code: parsed.codes[0].code,
                              name: "(tên sản phẩm)",
                            })}
                          />
                        </Stack>
                      ) : null}
                    </Stack>
                  ) : null}
                </Stack>

                <SchedulePicker
                  choice={schedule}
                  disabled={isRunning}
                  disabledReason="Lô đang chạy — chờ chạy xong rồi mới đổi được giờ đăng."
                  scopeNote="Áp dụng cho mọi mã và mọi kênh trong lượt chạy này. Các bài vẫn được đăng giãn cách theo cấu hình kênh, không lên cùng lúc."
                />

                <Divider />

                <Stack direction="vertical" gap={2}>
                  <HStack gap={2} align="center" wrap="wrap">
                    {/* A bulk run creates real posts on the customer's Pages;
                        support mode may not (M3.3). The rest of the form stays
                        readable so staff can still see what a customer set up. */}
                    <Button
                      type="submit"
                      variant="primary"
                      label={runLabel}
                      isDisabled={isRunning || gate.isDisabled}
                    />
                    {isRunning ? (
                      <Button
                        variant="destructive"
                        label={phase === "stopping" ? "Đang dừng…" : "Dừng"}
                        isDisabled={phase === "stopping"}
                        onClick={run.stop}
                      />
                    ) : null}
                    {phase === "finished" ? (
                      <Button
                        variant="ghost"
                        label="Xoá kết quả để chạy lượt mới"
                        onClick={run.reset}
                      />
                    ) : null}
                  </HStack>
                  <ReadOnlyNotice reason={gate.reason} />
                </Stack>
              </Stack>
            </form>

            <Divider />

            <BulkProgressSection
              phase={phase}
              summary={summary}
              rows={rows}
              isRunning={isRunning}
              ranScheduled={ranScheduled}
              summaryRef={summaryRef}
            />
          </Stack>
        </LayoutContent>
      }
    />
  );
}

/** Idle / running / finished view of the per-code results. */
function BulkProgressSection({
  phase,
  summary,
  rows,
  isRunning,
  ranScheduled,
  summaryRef,
}: {
  phase: BulkRunPhase;
  summary: BulkRunSummary;
  rows: readonly BulkRunRow[];
  isRunning: boolean;
  ranScheduled: boolean;
  summaryRef: React.RefObject<HTMLElement | null>;
}) {
  const isFinished = phase === "finished";

  return (
    <Stack direction="vertical" gap={3} paddingBlock={3}>
      <HStack gap={3} paddingInline={4} align="center" wrap="wrap">
        <Heading level={2}>
          Tiến độ
        </Heading>
        {rows.length > 0 ? (
          <Text type="supporting" role="status" aria-live="polite">
            Đã xử lý {summary.processed}/{summary.total} mã
            {isRunning ? " — đang chạy, đừng đóng tab." : "."}
          </Text>
        ) : null}
      </HStack>

      {rows.length === 0 ? (
        <Stack direction="vertical" paddingInline={4}>
          <EmptyState
            headingLevel={3}
            title="Chưa chạy lượt nào"
            description="Nhập mã, chọn kênh rồi bấm “Chạy”. Bảng này sẽ hiện trạng thái của từng mã ngay khi bắt đầu."
          />
        </Stack>
      ) : (
        <>
          {/* Focus target when the run ends: the outcome, not a dead button. */}
          <Stack
            direction="vertical"
            ref={summaryRef}
            tabIndex={-1}
            role={isFinished ? "alert" : undefined}
            paddingInline={4}
          >
            <Banner
              status={
                isFinished
                  ? summary.failed > 0
                    ? "warning"
                    : "success"
                  : "info"
              }
              title={
                isFinished
                  ? `Xong: ${summary.done} thành công · ${summary.skipped} bỏ qua · ${summary.failed} lỗi${
                      summary.cancelled > 0 ? ` · ${summary.cancelled} đã dừng` : ""
                    }.`
                  : `Đang chạy: ${summary.done} thành công · ${summary.skipped} bỏ qua · ${summary.failed} lỗi.`
              }
              description={`${
                summary.cancelled > 0
                  ? `${summary.cancelled} mã chưa chạy nên không bị ảnh hưởng gì. `
                  : ""
              }${
                ranScheduled
                  ? "Các lô đã tạo đang chờ tới giờ hẹn."
                  : "Các lô đã tạo chạy tiếp trên máy chủ kể cả khi bạn rời trang."
              }`}
              endContent={
                <Button
                  variant="secondary"
                  size="sm"
                  label={ranScheduled ? "Bài đã hẹn" : "Nhật ký đăng bài"}
                  href={ranScheduled ? "/scheduled" : "/jobs"}
                />
              }
            />
          </Stack>

          <StackItem size="fill">
            <BulkProgressTable rows={rows} />
          </StackItem>
        </>
      )}
    </Stack>
  );
}
