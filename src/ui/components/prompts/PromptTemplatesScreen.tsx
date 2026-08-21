"use client";

import {
  Banner,
  Button,
  CodeBlock,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Section,
  Skeleton,
  Stack,
  StatusDot,
  Text,
} from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";

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
 * Frame (`astryx docs layout`, settings archetype): the app-bar carries the
 * title and the one primary action, and the content column is capped so a
 * prompt body stays readable on a wide monitor instead of running edge to edge.
 *
 * The four mandatory states:
 *   loading — skeleton shaped like the loaded screen, delayed 300ms
 *   data    — "đang dùng" region + version rows + the create form
 *   empty   — cannot happen for the table (the built-in row is always there),
 *             so the empty state belongs to the tenant's OWN versions: it says
 *             "đang chạy mẫu mặc định", which is a different fact from "trống"
 *   error   — 4xx vs 5xx via <ApiErrorNotice>
 */
export function PromptTemplatesScreen() {
  const versions = usePromptVersions(PROMPT_TASK, PROMPT_PLATFORM);
  const create = useCreatePromptVersion(PROMPT_TASK, PROMPT_PLATFORM);
  const activate = useActivatePromptVersion(PROMPT_TASK, PROMPT_PLATFORM);
  // Support mode is read-only (M3.3): a prompt version decides what the AI
  // writes for the CUSTOMER's posts, so neither creating nor activating one is
  // something MYSP staff do from inside a support session.
  const gate = writeGate(useReadOnlyReason(), create.isPending);

  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<PromptVersionFormValues> | undefined>(undefined);
  /** Remount key: a new prefill must reset the uncontrolled RHF fields. */
  const [draftKey, setDraftKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const showSkeleton = useDelayedFlag(versions.isPending && versions.fetchStatus === "fetching");

  // Focus the result so a keyboard user lands on it instead of the old form.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  function openBlankForm() {
    create.reset();
    setDraft(undefined);
    setDraftKey((key) => key + 1);
    setFormOpen(true);
  }

  function reuse(version: PromptVersion) {
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
          setNotice(
            result.template.status === "active"
              ? `Đã lưu và kích hoạt phiên bản v${result.template.version}. Caption sinh từ giờ dùng bản này.`
              : `Đã lưu phiên bản v${result.template.version} ở dạng nháp. Bấm “Kích hoạt” khi muốn dùng.`,
          );
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
          setNotice(`Đã chuyển sang phiên bản v${template.version} (${template.name}).`),
        onError: () => setNotice(null),
      },
    );
  }

  const data = versions.data;
  const tenantVersions = data?.versions.filter((item) => item.source === "tenant") ?? [];
  /* One "tạo phiên bản" button on screen at a time: while the tenant has none,
     the empty state owns that call to action. */
  const showHeaderCreate = !gate.isDisabled && !formOpen && tenantVersions.length > 0;

  return (
    <Layout
      height="fill"
      contentWidth={1120}
      header={
        <LayoutHeader hasDivider>
          <HStack gap={4} padding={4} justify="between" align="start" wrap="wrap">
            <Stack direction="vertical" gap={1} maxWidth={640}>
              <Heading level={1}>Mẫu prompt AI</Heading>
              <Text type="supporting">
                Prompt dùng để AI viết caption Facebook. Mỗi lần sửa là một phiên bản mới — bản cũ
                giữ nguyên để truy lại caption đã sinh. Chỉ một phiên bản được dùng tại một thời
                điểm.
              </Text>
              {/* Said once, at the top, instead of beside every dead button. */}
              {gate.isDisabled ? <ReadOnlyNotice reason={gate.reason} /> : null}
            </Stack>

            {showHeaderCreate ? (
              <Button
                variant="primary"
                size="sm"
                label="Tạo phiên bản mới"
                onClick={openBlankForm}
              />
            ) : null}
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4} isScrollable>
          <Stack direction="vertical" gap={4}>
            {notice ? (
              <Banner
                ref={noticeRef}
                tabIndex={-1}
                role="alert"
                status="success"
                isDismissable
                onDismiss={() => setNotice(null)}
                title="Đã lưu thay đổi"
                description={notice}
              />
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
                {/* What is live right now: the one fact the operator opens this
                    screen for, so it sits first and reads as a region of the
                    page (astryx docs Section), not as a card. `role="region"`
                    because Astryx's Section is a visual container (a div), and
                    this block was a landmark before the redesign — dropping it
                    would cost a screen-reader user a jump target. */}
                <Section
                  variant="muted"
                  padding={4}
                  role="region"
                  aria-labelledby="prompt-active-heading"
                >
                  <Stack direction="vertical" gap={3}>
                    <HStack gap={3} justify="between" align="center" wrap="wrap">
                      <Heading id="prompt-active-heading" level={2}>
                        Đang dùng
                      </Heading>
                      <HStack gap={2} align="center">
                        <StatusDot variant="success" label="Đang chạy" />
                        <Text weight="medium">
                          {data.effective.source === "built_in"
                            ? "Mẫu mặc định của hệ thống"
                            : `Phiên bản v${data.effective.version}`}
                        </Text>
                      </HStack>
                    </HStack>

                    <HStack gap={2} align="center" wrap="wrap">
                      <Text type="supporting">Tên:</Text>
                      <Text weight="medium">{data.effective.name}</Text>
                    </HStack>

                    {/* The live prompt, monospaced and copyable — an operator
                        comparing it with a draft should not have to select it
                        by hand. */}
                    <CodeBlock
                      code={data.effective.body}
                      language="plaintext"
                      isWrapped
                      width="100%"
                      maxHeight={280}
                      container="card"
                    />
                  </Stack>
                </Section>

                {tenantVersions.length === 0 ? (
                  <EmptyState
                    headingLevel={2}
                    title="Đơn vị này chưa có phiên bản riêng"
                    description="Hệ thống đang chạy mẫu prompt mặc định đi kèm sản phẩm. Tạo phiên bản riêng khi muốn đổi giọng văn, độ dài hay cách gắn hashtag."
                    actions={
                      !gate.isDisabled && !formOpen ? (
                        <Button
                          variant="primary"
                          label="Tạo phiên bản đầu tiên"
                          onClick={openBlankForm}
                        />
                      ) : undefined
                    }
                  />
                ) : null}

                <Stack
                  as="section"
                  direction="vertical"
                  gap={2}
                  aria-labelledby="prompt-versions-heading"
                >
                  <HStack gap={3} align="center" wrap="wrap">
                    <Heading id="prompt-versions-heading" level={2}>
                      Các phiên bản
                    </Heading>
                    <Text type="supporting" role="status" aria-live="polite">
                      {data.versions.length} phiên bản
                    </Text>
                  </HStack>

                  <PromptVersionTable
                    versions={data.versions}
                    activatingVersion={
                      activate.isPending ? (activate.variables?.version ?? null) : null
                    }
                    disabled={gate.isDisabled}
                    onActivate={handleActivate}
                    onReuse={reuse}
                  />
                </Stack>

                {formOpen ? (
                  <Section variant="section" padding={4} dividers={["top"]}>
                    <PromptVersionForm
                      key={draftKey}
                      nextVersion={data.nextVersion}
                      defaultValues={draft}
                      pending={create.isPending}
                      error={create.isError ? create.error : undefined}
                      warnings={create.data?.warnings}
                      onSubmit={submit}
                      onCancel={() => {
                        create.reset();
                        setFormOpen(false);
                      }}
                    />
                  </Section>
                ) : null}
              </>
            ) : null}
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
      <Section variant="muted" padding={4}>
        <Stack direction="vertical" gap={3}>
          <HStack gap={3} justify="between" align="center">
            <Skeleton width={140} height={24} />
            <Skeleton width={180} height={20} />
          </HStack>
          <Skeleton width={320} height={16} />
          <Skeleton width="100%" height={160} />
        </Stack>
      </Section>

      <Stack direction="vertical" gap={2}>
        <Skeleton width={200} height={24} />
        {[0, 1, 2].map((row) => (
          <HStack key={row} gap={3} paddingBlock={2} align="center">
            <Skeleton width={90} height={16} index={row} />
            <Skeleton width="100%" height={16} index={row} />
            <Skeleton width={140} height={16} index={row} />
            <Skeleton width={160} height={16} index={row} />
            <Skeleton width={340} height={16} index={row} />
          </HStack>
        ))}
      </Stack>
    </Stack>
  );
}
