"use client";

import {
  AlertDialog,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Skeleton,
  Stack,
  Text,
} from "@astryxdesign/core";
import { useEffect, useId, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { PromptVersionForm } from "@/ui/components/prompts/PromptVersionForm";
import { PromptVersionTable } from "@/ui/components/prompts/PromptVersionTable";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import {
  useActivatePromptVersion,
  useCreatePromptVersion,
  usePromptVersions,
} from "@/ui/hooks/usePromptTemplates";
import {
  PROMPT_PLATFORM,
  PROMPT_TASK,
  type PromptVersion,
  type PromptVersionFormValues,
} from "@/ui/schemas/prompt.schema";

/**
 * "Mẫu prompt" (E10.7): component -> hook -> service -> internal API.
 *
 * What the screen is for: seeing which prompt is producing today's captions,
 * reading its exact text, writing the next version, and rolling back to an
 * older one. Prompt rows are immutable, so there is no edit button anywhere —
 * "sửa" means "dùng làm bản nháp" then save a new version.
 *
 * WAVE 2 — where the form lives: "Tạo phiên bản mới" now opens as an inline
 * panel DIRECTLY under the button that asked for it, with focus in the first
 * field. It used to render at the very bottom of the page, so clicking a button
 * in the middle of the screen appeared to do nothing at all.
 *
 * The four mandatory states:
 *   loading — skeleton with the real blocks, delayed 300ms
 *   data    — active banner + version table + create form
 *   empty   — cannot happen for the table (the built-in row is always there),
 *             so the empty state belongs to the tenant's OWN versions: it says
 *             "đang chạy mẫu mặc định", which is a different fact from "trống"
 *   error   — 4xx vs 5xx via <ApiErrorNotice>
 */
/** Result of the last write, plus the non-blocking remarks the API sent with it. */
interface ScreenNotice {
  message: string;
  warnings: readonly string[];
}

export function PromptTemplatesScreen() {
  const versions = usePromptVersions(PROMPT_TASK, PROMPT_PLATFORM);
  const create = useCreatePromptVersion(PROMPT_TASK, PROMPT_PLATFORM);
  const activate = useActivatePromptVersion(PROMPT_TASK, PROMPT_PLATFORM);
  // Support mode is read-only (M3.3): a prompt version decides what the AI
  // writes for the CUSTOMER's posts, so neither creating nor activating one is
  // something MYSP staff do from inside a support session.
  const gate = writeGate(useReadOnlyReason(), create.isPending);

  const formPanelId = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<PromptVersionFormValues> | undefined>(undefined);
  /** Remount key: a new prefill must reset the uncontrolled RHF fields. */
  const [draftKey, setDraftKey] = useState(0);
  const [notice, setNotice] = useState<ScreenNotice | null>(null);
  /** Whether the open panel holds typed work that a prefill would destroy. */
  const [formDirty, setFormDirty] = useState(false);
  /** Row whose text is waiting to overwrite that work, pending confirmation. */
  const [pendingReuse, setPendingReuse] = useState<PromptVersion | null>(null);
  /**
   * Every write unmounts the control that was clicked — the form panel closes,
   * and an activated row loses its "Kích hoạt" button. So the result banner is
   * the landing spot: focus goes to the answer instead of falling to <body>.
   */
  const noticeRef = useRef<HTMLDivElement>(null);
  /** Cancelling produces no banner, so focus goes back to what opened the panel. */
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Fallback landing spot when there is no trigger (read-only session). */
  const headingRef = useRef<HTMLHeadingElement>(null);

  const showSkeleton = useDelayedFlag(versions.isPending && versions.fetchStatus === "fetching");

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  function openBlankForm() {
    create.reset();
    setDraft(undefined);
    setDraftKey((key) => key + 1);
    setFormOpen(true);
  }

  function closeForm() {
    create.reset();
    setFormOpen(false);
    triggerRef.current?.focus();
  }

  /** Dismissing the result must not drop focus on the floor. */
  function dismissNotice() {
    setNotice(null);
    (triggerRef.current ?? headingRef.current)?.focus();
  }

  /**
   * Prefilling REPLACES whatever is in the open panel. Doing that silently
   * throws away typed work, so the confirmation comes first and the prefill
   * only happens on the far side of it.
   */
  function reuse(version: PromptVersion) {
    if (formOpen && formDirty) {
      setPendingReuse(version);
      return;
    }
    applyReuse(version);
  }

  function applyReuse(version: PromptVersion) {
    create.reset();
    setDraft({
      name: `${version.name} (bản sửa)`,
      systemPrompt: version.systemPrompt ?? "",
      body: version.body ?? "",
      changelog: "",
      activate: false,
    });
    setDraftKey((key) => key + 1);
    setFormOpen(true);
  }

  function submit(values: PromptVersionFormValues) {
    setNotice(null);
    create.mutate(
      {
        name: values.name,
        systemPrompt: values.systemPrompt,
        body: values.body,
        changelog: values.changelog,
        activate: values.activate,
      },
      {
        onSuccess: (result) => {
          setFormOpen(false);
          setNotice({
            message:
              result.template.status === "active"
                ? `Đã lưu và kích hoạt phiên bản v${result.template.version}. Caption sinh từ giờ dùng bản này.`
                : `Đã lưu phiên bản v${result.template.version} ở dạng nháp. Bấm “Kích hoạt” khi muốn dùng.`,
            warnings: result.warnings,
          });
        },
        // The refusal is rendered inside the form, next to the body field.
        onError: () => setNotice(null),
      },
    );
  }

  function handleActivate(version: number) {
    setNotice(null);
    activate.mutate(
      { version },
      {
        onSuccess: (template) =>
          setNotice({
            message: `Đã chuyển sang phiên bản v${template.version} (${template.name}).`,
            warnings: [],
          }),
        onError: () => setNotice(null),
      },
    );
  }

  const data = versions.data;
  const tenantVersions = data?.versions.filter((item) => item.source === "tenant") ?? [];

  return (
    <Layout
      height="auto"
      header={
        <LayoutHeader hasDivider>
          {/* `AppShell contentPadding={0}` (AppFrame) means the shell adds no
              inline padding of its own, so the page column's `px-6` is the only
              one — claiming the block axis here and none of the inline axis is
              what lets the divider run the full width of that column. */}
          <Stack direction="vertical" gap={1} paddingBlock={3} paddingInline={0}>
            <HStack gap={3} justify="between" align="start" wrap="wrap">
              <Heading level={1} ref={headingRef} tabIndex={-1}>
                Mẫu prompt AI
              </Heading>
              <Button
                size="sm"
                variant="secondary"
                label="Tải lại danh sách phiên bản"
                isLoading={versions.isFetching}
                isDisabled={versions.isFetching}
                onClick={() => void versions.refetch()}
              >
                Tải lại
              </Button>
            </HStack>
            <Text type="supporting">
              Prompt để AI viết caption Facebook. Mỗi lần sửa là một phiên bản mới — bản cũ giữ
              nguyên, và chỉ một bản được dùng tại một thời điểm.
            </Text>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <Stack direction="vertical" gap={4} paddingBlock={4} paddingInline={0}>
            {notice ? (
              // Warnings ride along with the result instead of living inside the
              // form: the form is closed by the time the server answers, so a
              // banner in there would never be read.
              <Banner
                ref={noticeRef}
                tabIndex={-1}
                // Astryx picks the role from `status` (success -> status,
                // warning -> alert); an override here would only weaken the
                // announcement of the warning case.
                status={notice.warnings.length > 0 ? "warning" : "success"}
                title={notice.message}
                description={
                  notice.warnings.length > 0 ? "Có lưu ý cần đọc trước khi dùng:" : undefined
                }
                isDismissable
                onDismiss={dismissNotice}
                defaultIsExpanded={notice.warnings.length > 0}
              >
                {notice.warnings.length > 0 ? (
                  <Stack direction="vertical" gap={1}>
                    {notice.warnings.map((warning) => (
                      <Text key={warning} type="supporting">
                        {warning}
                      </Text>
                    ))}
                  </Stack>
                ) : null}
              </Banner>
            ) : null}

            {/*
              No retry button: the list was already re-read (onSettled), so the
              truth on screen is fresh and the operator decides what to do next.
              A "Thử lại" that only hides the message would be a lie
              (core-feedback-states).
            */}
            {activate.isError ? <ApiErrorNotice error={activate.error} /> : null}

            {showSkeleton ? <PromptVersionsSkeleton /> : null}

            {!showSkeleton && versions.isError ? (
              <ApiErrorNotice error={versions.error} onRetry={() => void versions.refetch()} />
            ) : null}

            {!versions.isError && data ? (
              <>
                <Card padding={4} aria-labelledby="prompt-active-heading">
                  <Stack direction="vertical" gap={3}>
                    <HStack gap={2} justify="between" align="center" wrap="wrap">
                      <Heading level={2} id="prompt-active-heading">
                        Đang dùng
                      </Heading>
                      <Badge
                        variant={data.effective.source === "built_in" ? "neutral" : "success"}
                        label={
                          data.effective.source === "built_in"
                            ? "Mẫu mặc định của hệ thống"
                            : `Phiên bản v${data.effective.version}`
                        }
                      />
                    </HStack>
                    <HStack gap={2} align="center" wrap="wrap">
                      <Text type="supporting" color="secondary">
                        Tên
                      </Text>
                      <Text weight="medium">{data.effective.name}</Text>
                    </HStack>
                    <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs break-words whitespace-pre-wrap">
                      {data.effective.body}
                    </pre>
                  </Stack>
                </Card>

                {tenantVersions.length === 0 ? (
                  <EmptyState
                    headingLevel={2}
                    title="Đơn vị này chưa có phiên bản riêng"
                    // A read-only session has no create button anywhere on the
                    // screen, so the first-run copy must not point at one.
                    description={
                      gate.isDisabled
                        ? `Hệ thống đang chạy mẫu prompt mặc định đi kèm sản phẩm. ${
                            gate.reason ?? "Phiên này chỉ xem, không tạo phiên bản được."
                          }`
                        : "Hệ thống đang chạy mẫu prompt mặc định đi kèm sản phẩm. Tạo phiên bản riêng khi muốn đổi giọng văn, độ dài hay cách gắn hashtag."
                    }
                    actions={
                      gate.isDisabled || formOpen ? undefined : (
                        <Button
                          variant="primary"
                          label="Tạo phiên bản đầu tiên"
                          onClick={openBlankForm}
                        />
                      )
                    }
                  />
                ) : null}

                <Stack direction="vertical" gap={3}>
                  <HStack gap={3} justify="between" align="center" wrap="wrap">
                    <Heading level={2} id="prompt-versions-heading">
                      Các phiên bản ({data.versions.length})
                    </Heading>
                    {gate.isDisabled ? (
                      <ReadOnlyNotice reason={gate.reason} />
                    ) : (
                      <Button
                        ref={triggerRef}
                        variant="primary"
                        size="sm"
                        label="Tạo phiên bản mới"
                        aria-expanded={formOpen}
                        // Only while the panel is mounted — see the row toggles.
                        aria-controls={formOpen ? formPanelId : undefined}
                        isDisabled={formOpen}
                        // Only while the panel is open — and `tooltip` is what
                        // keeps the button aria-disabled rather than natively
                        // disabled, so it can take focus back when it closes.
                        tooltip={formOpen ? "Biểu mẫu đang mở ngay bên dưới." : undefined}
                        onClick={openBlankForm}
                      />
                    )}
                  </HStack>

                  {/*
                    Directly under the trigger, not at the bottom of the page:
                    the button and its consequence have to be one glance apart.
                  */}
                  {/* `!gate.isDisabled` as well as `formOpen`: the panel is a
                      write surface, and a read-only session must not be able to
                      reach one by any route (M3.3). */}
                  {formOpen && !gate.isDisabled ? (
                    <Card padding={4} id={formPanelId}>
                      <PromptVersionForm
                        key={draftKey}
                        nextVersion={data.nextVersion}
                        defaultValues={draft}
                        pending={create.isPending}
                        error={create.isError ? create.error : undefined}
                        onDirtyChange={setFormDirty}
                        onSubmit={submit}
                        onCancel={closeForm}
                      />
                    </Card>
                  ) : null}

                  <PromptVersionTable
                    versions={data.versions}
                    activatingVersion={
                      activate.isPending ? (activate.variables?.version ?? null) : null
                    }
                    disabled={gate.isDisabled}
                    readOnlyReason={gate.reason}
                    onActivate={handleActivate}
                    onReuse={reuse}
                  />
                </Stack>
              </>
            ) : null}

            {/* Overwriting typed work is not undoable, so it is confirmed —
                same contract as "Xoá nháp" on the compose screen. */}
            <AlertDialog
              isOpen={pendingReuse !== null}
              onOpenChange={(isOpen) => {
                if (!isOpen) setPendingReuse(null);
              }}
              title="Bỏ nội dung đang soạn?"
              description="Biểu mẫu đang mở có nội dung chưa lưu. Nạp phiên bản này vào sẽ ghi đè toàn bộ những gì bạn vừa gõ, và không lấy lại được."
              actionLabel="Nạp bản này"
              cancelLabel="Giữ nội dung đang soạn"
              onAction={() => {
                const version = pendingReuse;
                setPendingReuse(null);
                if (version) applyReuse(version);
              }}
            />
          </Stack>
        </LayoutContent>
      }
    />
  );
}

/** Same shape as the loaded screen so nothing jumps when data arrives. */
function PromptVersionsSkeleton() {
  return (
    <Stack direction="vertical" gap={4} aria-hidden="true">
      <Stack direction="vertical" gap={2}>
        <Skeleton width={160} height={20} />
        <Skeleton width="100%" height={96} />
      </Stack>
      <Stack direction="vertical" gap={2}>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} width="100%" height={32} index={row} />
        ))}
      </Stack>
    </Stack>
  );
}
