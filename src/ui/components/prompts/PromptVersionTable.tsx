"use client";

import { Fragment, useState } from "react";

import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  PROMPT_STATUS_LABELS,
  PROMPT_STATUS_TONES,
  formatPromptDate,
  type PromptVersion,
} from "@/ui/schemas/prompt.schema";

/**
 * Version table of the prompt catalog (E10.7).
 *
 * Three things it must make obvious:
 *  1. WHICH version is active — exactly one row, badge "Đang dùng";
 *  2. which row is the BUILT-IN template — read-only, cannot be activated by
 *     hand and cannot be deleted, because it is shipped in code;
 *  3. what each version changed (changelog) and what its body actually says.
 *
 * Activating an old version is a two-step confirmation (core-bulk-actions
 * §Xác nhận, level 1): it silently changes every caption generated afterwards,
 * so a stray click must not do it.
 *
 * Presentational: fetching and mutations live in the screen above.
 */
export function PromptVersionTable({
  versions,
  activatingVersion,
  disabled,
  onActivate,
  onReuse,
}: {
  versions: readonly PromptVersion[];
  /** Version currently being activated, so only its button shows the pending state. */
  activatingVersion: number | null;
  disabled?: boolean;
  onActivate: (version: number) => void;
  /** Prefills the "tạo phiên bản mới" form from this row. */
  onReuse: (version: PromptVersion) => void;
}) {
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-160 border-collapse text-sm">
        <caption className="sr-only">
          Các phiên bản prompt của tác vụ viết caption Facebook, mới nhất trước
        </caption>
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-medium">
              Phiên bản
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Tên
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Trạng thái
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Vì sao đổi
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Tạo lúc
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => {
            const isOpen = openVersion === version.version;
            const isConfirming = confirmVersion === version.version;
            const isBuiltIn = version.source === "built_in";
            const rowId = `prompt-v${version.version}-${version.source}`;

            return (
              <Fragment key={rowId}>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 font-medium tabular-nums">v{version.version}</td>
                  <td className="px-3 py-2">
                    <span className="break-words">{version.name}</span>
                    {isBuiltIn ? (
                      <Badge tone="neutral" className="ml-2 align-middle">
                        Mặc định hệ thống
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={PROMPT_STATUS_TONES[version.status]}>
                      {PROMPT_STATUS_LABELS[version.status]}
                    </Badge>
                  </td>
                  <td className="max-w-80 px-3 py-2 break-words">{version.changelog || "—"}</td>
                  <td className="px-3 py-2">
                    {formatPromptDate(version.createdAt)}
                    {version.createdBy ? (
                      <span className="text-muted-foreground block text-xs break-all">
                        {version.createdBy}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-expanded={isOpen}
                        aria-controls={`${rowId}-body`}
                        onClick={() => setOpenVersion(isOpen ? null : version.version)}
                      >
                        {isOpen ? "Ẩn nội dung" : "Xem nội dung"}
                      </Button>

                      {version.body ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onReuse(version)}
                        >
                          Dùng làm bản nháp
                        </Button>
                      ) : null}

                      {!isBuiltIn && version.status !== "active" ? (
                        isConfirming ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs">Kích hoạt v{version.version}?</span>
                            <Button
                              type="button"
                              size="sm"
                              disabled={disabled || activatingVersion !== null}
                              onClick={() => {
                                setConfirmVersion(null);
                                onActivate(version.version);
                              }}
                            >
                              {activatingVersion === version.version ? "Đang bật…" : "Xác nhận"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmVersion(null)}
                            >
                              Không
                            </Button>
                          </span>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={disabled || activatingVersion !== null}
                            onClick={() => setConfirmVersion(version.version)}
                          >
                            Kích hoạt
                          </Button>
                        )
                      ) : null}
                    </div>
                  </td>
                </tr>

                {isOpen ? (
                  <tr className="bg-muted/20 border-t">
                    <td id={`${rowId}-body`} colSpan={6} className="space-y-3 px-3 py-3">
                      <div className="space-y-1">
                        <h4 className="text-xs font-semibold">System prompt</h4>
                        <pre className="bg-background max-h-64 overflow-auto rounded-lg border p-3 text-xs break-words whitespace-pre-wrap">
                          {version.systemPrompt ?? "(không có sẵn nội dung cho phiên bản này)"}
                        </pre>
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-xs font-semibold">Nội dung prompt</h4>
                        <pre className="bg-background max-h-96 overflow-auto rounded-lg border p-3 text-xs break-words whitespace-pre-wrap">
                          {version.body ?? "(không có sẵn nội dung cho phiên bản này)"}
                        </pre>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Biến dùng trong bản này:{" "}
                        {version.variables.length > 0 ? version.variables.join(", ") : "(không có)"}.
                      </p>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
