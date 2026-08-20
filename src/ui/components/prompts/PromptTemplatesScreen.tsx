"use client";

import { useEffect, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { PromptVersionForm } from "@/ui/components/prompts/PromptVersionForm";
import { PromptVersionTable } from "@/ui/components/prompts/PromptVersionTable";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
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
 * The four mandatory states:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — active banner + version table + create form
 *   empty   — cannot happen for the table (the built-in row is always there),
 *             so the empty state belongs to the tenant's OWN versions: it says
 *             "đang chạy mẫu mặc định", which is a different fact from "trống"
 *   error   — 4xx vs 5xx via <ApiErrorNotice>
 */
export function PromptTemplatesScreen() {

  const versions = usePromptVersions(PROMPT_TASK, PROMPT_PLATFORM);
  const create = useCreatePromptVersion(PROMPT_TASK, PROMPT_PLATFORM);
  const activate = useActivatePromptVersion(PROMPT_TASK, PROMPT_PLATFORM);

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

  return (
    <section className="space-y-6" aria-labelledby="prompts-heading">
      <header className="space-y-1">
        <h1 id="prompts-heading" className="text-2xl font-semibold tracking-tight">
          Mẫu prompt AI
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Prompt dùng để AI viết caption Facebook. Mỗi lần sửa là một phiên bản mới — bản cũ giữ
          nguyên để truy lại caption đã sinh. Chỉ một phiên bản được dùng tại một thời điểm.
        </p>
      </header>

      {notice ? (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role="alert"
          className="border-success/30 bg-success/10 text-success-foreground rounded-lg border px-3 py-2 text-sm outline-none"
        >
          {notice}
        </div>
      ) : null}

      {/*
        No retry button: the list was already re-read (onSettled), so the truth
        on screen is fresh and the operator decides what to do next. A "Thử lại"
        that only hides the message would be a lie (core-feedback-states).
      */}
      {activate.isError ? <ApiErrorNotice error={activate.error} /> : null}

      {showSkeleton ? <PromptVersionsSkeleton /> : null}

      {!showSkeleton && versions.isError ? (
        <ApiErrorNotice error={versions.error} onRetry={() => void versions.refetch()} />
      ) : null}

      {!versions.isError && data ? (
        <>
          <section
            aria-labelledby="prompt-active-heading"
            className="bg-card space-y-3 rounded-xl border p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="prompt-active-heading" className="text-base font-semibold">
                Đang dùng
              </h2>
              <Badge tone={data.effective.source === "built_in" ? "neutral" : "success"}>
                {data.effective.source === "built_in"
                  ? "Mẫu mặc định của hệ thống"
                  : `Phiên bản v${data.effective.version}`}
              </Badge>
            </div>
            <p className="text-sm">
              <span className="text-muted-foreground">Tên:</span>{" "}
              <span className="font-medium break-words">{data.effective.name}</span>
            </p>
            <pre className="bg-muted/40 max-h-64 overflow-auto rounded-lg border p-3 text-xs break-words whitespace-pre-wrap">
              {data.effective.body}
            </pre>
          </section>

          {tenantVersions.length === 0 ? (
            <EmptyState
              kind="first-run"
              title="Đơn vị này chưa có phiên bản riêng"
              description="Hệ thống đang chạy mẫu prompt mặc định đi kèm sản phẩm. Tạo phiên bản riêng khi muốn đổi giọng văn, độ dài hay cách gắn hashtag."
              action={
                !formOpen ? (
                  <Button type="button" onClick={openBlankForm}>
                    Tạo phiên bản đầu tiên
                  </Button>
                ) : null
              }
            />
          ) : null}

          <section aria-labelledby="prompt-versions-heading" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="prompt-versions-heading" className="text-lg font-semibold">
                Các phiên bản ({data.versions.length})
              </h2>
              {!formOpen ? (
                <Button type="button" variant="outline" onClick={openBlankForm}>
                  Tạo phiên bản mới
                </Button>
              ) : null}
            </div>

            <PromptVersionTable
              versions={data.versions}
              activatingVersion={activate.isPending ? (activate.variables?.version ?? null) : null}
              disabled={create.isPending}
              onActivate={handleActivate}
              onReuse={reuse}
            />
          </section>

          {formOpen ? (
            <section className="bg-card rounded-xl border p-5">
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
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Same shape as the loaded screen so nothing jumps when data arrives. */
function PromptVersionsSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
      <div className="space-y-2 rounded-xl border p-5">
        <div className="bg-muted h-5 w-32 rounded" />
        <div className="bg-muted h-24 w-full rounded" />
      </div>
      <div className="space-y-2 rounded-xl border p-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="bg-muted h-8 w-full rounded" />
        ))}
      </div>
    </div>
  );
}
