"use client";

import {
  Collapsible,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Text,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";

import { BulkCodesField } from "@/ui/components/bulk/BulkCodesField";
import { BulkProgressTable } from "@/ui/components/bulk/BulkProgressTable";
import { pruneSelection } from "@/ui/components/channels/channel-option-labels";
import { ChannelGroupPicker } from "@/ui/components/compose/ChannelGroupPicker";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Button } from "@/ui/components/ui/button";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { Textarea } from "@/ui/components/ui/textarea";
import { useBulkRun } from "@/ui/hooks/useBulkRun";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
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

/**
 * "Chạy hàng loạt" (E10.5): component -> hook -> service -> internal API.
 *
 * The order of the screen is the order of the business rules (rule 1): the
 * codes, then the channels, then the caption, then "Chạy". Each code goes
 * through compose (stock gate first) before any caption is asked for. The four
 * steps are numbered for that reason and for that reason only — the sequence is
 * business fact, not a wizard: every step is on screen at once and nothing here
 * gates anything (same argument as the compose step rail).
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

/** Why the run trigger is off before a single code has been typed. */
const EMPTY_CODES_REASON =
  "Chưa có mã nào để chạy — nhập ít nhất một mã sản phẩm vào ô phía trên.";

/**
 * The one sentence about what closing the tab costs, said where the decision is
 * made — beside the trigger, not in an intro paragraph nobody rereads.
 *
 * It has to draw the line in both directions, because the loop is half in the
 * browser and half on the server: a batch that exists is the server's problem
 * from then on, a code that never reached `createPostBatch` simply will not run.
 * The vaguer "đừng đóng tab giữa chừng" it replaces made operators believe the
 * posts already created would be lost too.
 */
const TAB_BOUNDARY_NOTICE =
  "Đóng tab: các lô ĐÃ tạo vẫn đăng tiếp trên máy chủ; các mã CHƯA tạo lô sẽ dừng.";

export function BulkRunScreen() {
  const codesId = useId();
  const templateId = useId();
  const captionModeId = useId();

  const groups = useChannelGroups();
  // The groups hold ids; this holds the names those ids stand for. Separate
  // query, separate failure: losing the names must not stop the run.
  const channels = useChannels();
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

  /**
   * THE RACE this closes: the Page list renders from the GROUPS, which arrive
   * before `useChannels` answers. Until that answer lands every row is tickable
   * (an unknown channel list may accuse nothing), so a Page that turns out to
   * be switched off or removed can already be ticked — and those ids would
   * travel into `run.start`, one blocked job per code.
   *
   * DERIVED, not reconciled in an effect: what the box holds is what the
   * operator asked for, and what runs is that intersected with what the server
   * says can run. So a Page switched back on returns to the selection by
   * itself, and there is no second copy of the truth to keep in sync.
   */
  const prune = useMemo(
    () => pruneSelection(selected, channels.data?.channels),
    [selected, channels.data],
  );
  const runnableSelection = useMemo(
    () => (prune.changed ? new Set(prune.next) : selected),
    [prune, selected],
  );

  const selectedIds = useMemo(() => [...runnableSelection], [runnableSelection]);
  const groupItems = groups.data?.groups ?? [];
  const { phase, summary, rows, isRunning } = run;

  // Support mode is read-only (M3.3): a bulk run publishes to the customer's
  // Pages, so the trigger goes off with its reason attached.
  const gate = writeGate(useReadOnlyReason(), isRunning);

  /**
   * "Chạy 0 mã" was a live button. It could only ever fail — the zod schema
   * rejects an empty list — and it read as an offer to run something. Off, with
   * the sentence beside it saying what is missing (The Named Status Rule):
   * a dimmed control that explains nothing is what core-auth-session forbids,
   * and the same shape the read-only gate already uses on this screen.
   *
   * Read-only wins the sentence: it is the harder stop, and typing codes would
   * not clear it.
   */
  const hasNoCodes = parsed.codes.length === 0;
  const runBlockedReason = gate.reason ?? (hasNoCodes ? EMPTY_CODES_REASON : null);

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

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="flex flex-wrap items-start justify-between gap-4 p-4">
            <div className="max-w-prose space-y-1">
              <Heading level={1}>Chạy hàng loạt</Heading>
              {/* Two sentences: what the screen does, and what it does when a
                  code is refused. Everything else is one click away below
                  (spec §3.4 — đổi liều lượng, không xoá thông tin). */}
              <Text type="supporting">
                Dán danh sách mã, chọn kênh rồi chạy tuần tự từng mã. Mã hết hàng hoặc thiếu ảnh bị
                bỏ qua kèm lý do — cả lô vẫn chạy tiếp.
              </Text>
            </div>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          {/* `relative`, and it is load-bearing — the same trap AppFrame
              documents, one level down. `sr-only` is `position: absolute`, so
              every visually hidden node in this form (the picker's checkboxes,
              the fieldset legend, the table caption) anchors to the nearest
              POSITIONED ancestor. Astryx's layout content is `static`, so they
              were escaping this scroll box and landing on the shell wrapper
              above it — measured: wrapper scrollHeight 1313 against a 952
              client, i.e. a SECOND scrollbar with 361px of empty background in
              it, on top of the one this content already has. */}
          <div className="relative mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
            <ScopeDisclosure />

            <form noValidate className="space-y-6" onSubmit={form.handleSubmit(handleSubmit)}>
              <Step label="Bước 1 — Mã sản phẩm">
                <BulkCodesField
                  id={codesId}
                  registration={form.register("codesText")}
                  parsed={parsed}
                  error={form.formState.errors.codesText?.message}
                  disabled={isRunning}
                />
              </Step>

              <Step label="Bước 2 — Kênh đăng">
                <p className="text-muted-foreground text-xs">Áp dụng cho mọi mã trong lượt chạy.</p>
                <ChannelGroupPicker
                  groups={groupItems}
                  channels={channels.data?.channels}
                  // The RUNNABLE set, not the raw one: a row the server has since
                  // switched off must not keep showing a tick that means nothing.
                  selected={runnableSelection}
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
                    <Link href="/channels?tab=groups" className="underline underline-offset-4">
                      Quản lý nhóm kênh
                    </Link>
                  </p>
                ) : null}
                {/* Said out loud: without it the list quietly falls back to mã kênh
                    and nobody knows whether that is normal. */}
                {channels.isError ? (
                  <p className="text-muted-foreground text-xs">
                    Không tải được tên Page nên danh sách đang hiện mã kênh. Vẫn chọn và chạy được
                    bình thường.
                  </p>
                ) : null}
                {/* `role="status"`, not alert: nothing the operator did went wrong,
                    but a Page they ticked is not going to receive the post, and that
                    has to be said here rather than discovered in the result table one
                    blocked code at a time (business rule 5). */}
                {prune.changed ? (
                  <p
                    role="status"
                    className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
                  >
                    {prune.removedLabels.length} Page đã tick sẽ KHÔNG được đăng vì kênh đang tắt
                    hoặc đã bị gỡ: {prune.removedLabels.join(", ")}. Bật lại ở màn Kênh nếu vẫn muốn
                    đăng.
                  </p>
                ) : null}
                {channelError ? (
                  <p role="alert" className="text-destructive text-sm">
                    {channelError}
                  </p>
                ) : null}
              </Step>

              <Step label="Bước 3 — Caption">
                <fieldset className="space-y-3" aria-describedby={`${captionModeId}-hint`}>
                  <legend className="sr-only">Cách viết caption</legend>
                  <p id={`${captionModeId}-hint`} className="text-muted-foreground text-xs">
                    Caption chỉ dùng tên, mô tả, chủng loại, mùa vụ của sản phẩm. Không có biến giá
                    hay tồn kho — thông tin đó không bao giờ đi vào bài đăng.
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
                        Biến dùng được:{" "}
                        {CAPTION_TEMPLATE_VARIABLES.map((name) => `{${name}}`).join(", ")}. Các biến
                        khác giữ nguyên chữ, không được thay.
                      </p>
                      {form.formState.errors.captionTemplate ? (
                        <p role="alert" className="text-destructive text-sm">
                          {form.formState.errors.captionTemplate.message}
                        </p>
                      ) : null}
                      {unknownVariables.length > 0 ? (
                        <p role="alert" className="text-warning-foreground text-xs">
                          Không nhận ra biến {unknownVariables.map((name) => `{${name}}`).join(", ")}{" "}
                          — sẽ giữ nguyên chữ trong caption. Chỉ có{" "}
                          {CAPTION_TEMPLATE_VARIABLES.map((n) => `{${n}}`).join(", ")} được thay.
                        </p>
                      ) : null}
                      {captionTemplate.trim().length > 0 && parsed.codes.length > 0 ? (
                        <div className="space-y-1">
                          <p className="text-muted-foreground text-xs">
                            Xem thử với mã{" "}
                            <span className="font-mono whitespace-nowrap">
                              {parsed.codes[0].code}
                            </span>{" "}
                            (tên sản phẩm lấy từ dữ liệu khi chạy):
                          </p>
                          <pre className="border-border bg-muted/40 max-h-48 overflow-auto rounded-md border p-3 text-sm break-words whitespace-pre-wrap">
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
              </Step>

              {/* The schedule and the trigger share a card: "khi nào" and "chạy"
                  are one decision, and `SchedulePicker` brings its own legend —
                  a step whose only child repeats the step's name back at it is
                  two labels for one block. */}
              <Step label="Bước 4 — Chạy lô">
                <SchedulePicker
                  choice={schedule}
                  disabled={isRunning}
                  disabledReason="Lô đang chạy — chờ chạy xong rồi mới đổi được giờ đăng."
                  scopeNote="Áp dụng cho mọi mã và mọi kênh trong lượt chạy này. Các bài vẫn được đăng giãn cách theo cấu hình kênh, không lên cùng lúc."
                />

                {/* A bulk run creates real posts on the customer's Pages; support
                    mode may not (M3.3). The rest of the form stays readable so staff
                    can still see what a customer had set up. */}
                <div className="border-border flex flex-wrap items-center gap-2 border-t pt-4">
                  <Button type="submit" disabled={isRunning || gate.isDisabled || hasNoCodes}>
                    {isRunning
                      ? "Đang chạy…"
                      : hasNoCodes
                        ? // Not "Chạy 0 mã": a button names the action it would
                          // take, and there is no such action while the box is
                          // empty.
                          schedule.mode === "scheduled"
                          ? "Hẹn giờ"
                          : "Chạy"
                        : schedule.mode === "scheduled"
                          ? `Hẹn giờ ${parsed.codes.length} mã`
                          : `Chạy ${parsed.codes.length} mã`}
                  </Button>
                  {isRunning ? (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={run.stop}
                      disabled={phase === "stopping"}
                    >
                      {phase === "stopping" ? "Đang dừng…" : "Dừng"}
                    </Button>
                  ) : null}
                  {phase === "finished" ? (
                    <Button type="button" variant="ghost" onClick={run.reset}>
                      Xoá kết quả để chạy lượt mới
                    </Button>
                  ) : null}
                  <ReadOnlyNotice reason={runBlockedReason} className="basis-full" />
                  {/* Beside the trigger, where the decision is made. */}
                  <p className="text-muted-foreground max-w-prose basis-full text-[13px]">
                    {TAB_BOUNDARY_NOTICE}
                  </p>
                </div>
              </Step>
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
                  {/* Its own live region, OUTSIDE the summary card: the card
                      turns into a `role="alert"` the moment the run ends, and a
                      polite region nested inside an alert is a fight over the
                      same announcement. */}
                  <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
                    Đã xử lý {summary.processed}/{summary.total} mã
                    {isRunning ? " — đang chạy." : "."}
                  </p>

                  <div
                    ref={summaryRef}
                    tabIndex={-1}
                    role={phase === "finished" ? "alert" : undefined}
                    className="border-border bg-card space-y-1 rounded-md border p-4 text-sm outline-none"
                  >
                    <p className="font-medium">
                      {phase === "finished"
                        ? `Xong: ${summary.done} thành công · ${summary.skipped} bỏ qua · ${summary.failed} lỗi${
                            summary.cancelled > 0 ? ` · ${summary.cancelled} đã dừng` : ""
                          }.`
                        : `Đang chạy: ${summary.done} thành công · ${summary.skipped} bỏ qua · ${summary.failed} lỗi.`}
                    </p>
                    <p className="text-muted-foreground">
                      {summary.cancelled > 0
                        ? `${summary.cancelled} mã chưa chạy nên không bị ảnh hưởng gì. `
                        : ""}
                      {ranScheduled
                        ? "Các lô đã tạo đang chờ tới giờ hẹn — đổi giờ hoặc huỷ ở "
                        : "Các lô đã tạo chạy tiếp trên máy chủ kể cả khi bạn rời trang — xem ở "}
                      {ranScheduled ? (
                        <Link href="/posts?tab=scheduled" className="underline underline-offset-4">
                          Bài đã hẹn
                        </Link>
                      ) : (
                        <Link href="/posts?tab=log" className="underline underline-offset-4">
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
          </div>
        </LayoutContent>
      }
    />
  );
}

/**
 * One numbered stop of the run form, on its own swatch card.
 *
 * The Eyebrow IS the label of the block (The Woven Label Rule) — a `<p>`, not a
 * heading, referenced by the section so the block still has an accessible name
 * without adding a second outline entry beside the field labels inside it.
 *
 * Numbers, deliberately: they name the order the business runs in (tra mã và
 * kiểm tồn → chọn kênh → caption → giờ đăng, CLAUDE.md rule 1), which is the one
 * sequence on this screen a reader genuinely needs. Nothing is gated: every step
 * is on screen at once and the order never changes with the state of the form.
 */
function Step({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();

  return (
    <section
      aria-labelledby={labelId}
      className="border-border bg-card space-y-3 rounded-md border p-4"
    >
      <Eyebrow id={labelId}>{label}</Eyebrow>
      {children}
    </section>
  );
}

/**
 * What this screen does NOT do, folded away.
 *
 * It used to be the second half of the intro, where it was read once and then
 * skipped forever by the operator who runs 30 codes every morning — while
 * costing four lines at the top of the screen every single time (spec §3.4).
 * Shut by default: `defaultIsOpen` is `true` in Astryx.
 */
function ScopeDisclosure() {
  return (
    <section
      aria-label="Chi tiết cách chạy hàng loạt"
      className="border-border bg-card rounded-md border px-2"
    >
      <Collapsible
        defaultIsOpen={false}
        trigger={<span className="text-sm font-medium">Chi tiết</span>}
      >
        <div className="text-muted-foreground max-w-prose space-y-2 px-2 pb-3 text-sm">
          <p>
            Màn này chỉ chạy <strong className="text-foreground font-medium">bài ảnh</strong>. Bài
            video cần chọn đích đăng và kiểm thông số từng clip, nên làm ở màn{" "}
            <Link href="/compose" className="underline underline-offset-4">
              Soạn bài
            </Link>
            .
          </p>
          <p>
            Vòng chạy nằm trong trình duyệt này: mỗi mã được tra sản phẩm, lấy caption rồi tạo lô,
            xong mã đó mới sang mã kế tiếp. {TAB_BOUNDARY_NOTICE}
          </p>
        </div>
      </Collapsible>
    </section>
  );
}
