"use client";

import { Heading, Stack, Text } from "@astryxdesign/core";
import { Check, Copy, Plus } from "lucide-react";
import { useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Button } from "@/ui/components/ui/button";
import { useCreateInvite } from "@/ui/hooks/useInvites";
import type { CreateInviteResponse } from "@/ui/schemas/invite.schema";
import type { MembershipRole } from "@/ui/schemas/me.schema";

/**
 * Step 02 of the first-run wizard — "Ai đăng bài cùng bạn?".
 *
 * Invites are LINKS, not e-mails. MYSP sends no mail: there is no mailer in the
 * deployment, no sending domain and no bounce handling, and a screen with an
 * "Email nhân viên" box would promise a message that never arrives — the worst
 * possible failure here, because the owner would sit waiting for someone who
 * was never told. So the screen mints a link per role and the owner sends it
 * through whatever they already use with their staff (Zalo, Messenger, SMS).
 *
 * Skippable on purpose: an owner alone in their company still has five setup
 * steps ahead of them, and being made to invite nobody first is a wall built
 * out of nothing.
 */

interface RoleOption {
  readonly role: Extract<MembershipRole, "admin" | "editor" | "viewer">;
  readonly label: string;
  /** What this role may actually do — read BEFORE the link is minted. */
  readonly summary: string;
}

/**
 * `owner` is absent by design: there is exactly one, it is the person on this
 * screen, and an invite link that mints a second one is a security hole with a
 * friendly label.
 */
const ROLE_OPTIONS: readonly RoleOption[] = [
  {
    role: "admin",
    label: "Quản lý nội dung",
    summary:
      "Soạn, duyệt, hẹn giờ, sửa kênh và nhóm kênh. Không xoá được công ty.",
  },
  {
    role: "editor",
    label: "Người đăng",
    summary: "Soạn bài và đăng. Không sửa được kênh, nhóm kênh hay thành viên.",
  },
  {
    role: "viewer",
    label: "Chỉ xem",
    summary: "Xem sản phẩm, bài và nhật ký đăng. Không thay đổi được gì.",
  },
];

export function WizardStepInvite({ onDone }: { onDone: () => void }) {
  const create = useCreateInvite();
  const [role, setRole] = useState<RoleOption["role"]>("admin");
  /** Links minted in THIS session — the only place their url ever appears. */
  const [minted, setMinted] = useState<readonly CreateInviteResponse[]>([]);

  const selected = ROLE_OPTIONS.find((option) => option.role === role) ?? ROLE_OPTIONS[0];

  return (
    <Stack direction="vertical" gap={4}>
      <Stack direction="vertical" gap={1}>
        <p className="text-muted-foreground font-mono text-[11px] tracking-[0.2em] uppercase">
          Bước 02 / 02
        </p>
        <Heading
          level={1}
          className="text-foreground text-2xl font-bold tracking-tight sm:text-3xl"
        >
          Ai đăng bài cùng bạn?
        </Heading>
        <Text type="supporting" className="text-muted-foreground mt-1 text-sm leading-relaxed">
          Tạo link mời theo vai trò rồi gửi cho nhân viên qua Zalo, Messenger hay tin nhắn. Ai mở
          link là vào đúng công ty này, bạn không phải cấu hình thêm.
        </Text>
      </Stack>

      {/* Role — a radiogroup, not a row of buttons: these are alternatives, and
          arrow keys must move between them. */}
      <Stack direction="vertical" gap={2}>
        <p className="text-foreground text-sm font-medium" id="invite-role-label">
          Vai trò cho người được mời
        </p>
        <div
          role="radiogroup"
          aria-labelledby="invite-role-label"
          className="flex flex-wrap gap-2"
        >
          {ROLE_OPTIONS.map((option) => {
            const isSelected = option.role === role;
            return (
              <button
                key={option.role}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setRole(option.role)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm outline-none",
                  "focus-visible:ring-ring/50 focus-visible:ring-3",
                  "motion-safe:transition-colors motion-safe:duration-150",
                  isSelected
                    ? "border-primary bg-accent text-accent-foreground font-medium"
                    : "border-border text-foreground hover:bg-muted",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <Text type="supporting" className="text-muted-foreground text-xs leading-relaxed">
          <span className="text-foreground font-medium">{selected.label}:</span> {selected.summary}
        </Text>
      </Stack>

      <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            create.mutate(
              { role },
              { onSuccess: (invite) => setMinted((links) => [...links, invite]) },
            )
          }
          disabled={create.isPending}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {create.isPending ? "Đang tạo link…" : "Tạo link mời"}
        </Button>
      </Stack>

      {create.isError ? <ApiErrorNotice error={create.error} /> : null}

      {minted.length > 0 ? <MintedLinks links={minted} /> : null}

      {/*
        Both ways forward, side by side, and neither is a dead end. "Mời sau" is
        not a lesser option: it is the honest one for an owner who is alone
        today, and burying it would only teach them to mint a link they will
        never send.
      */}
      <Stack direction="horizontal" gap={3} align="center" wrap="wrap" className="pt-1">
        <Button type="button" onClick={onDone} size="lg">
          Vào MYSP
        </Button>
        <button
          type="button"
          onClick={onDone}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded text-sm underline underline-offset-4 outline-none focus-visible:ring-2"
        >
          Mời sau, vào làm việc trước
        </button>
      </Stack>
    </Stack>
  );
}

/**
 * The minted links.
 *
 * This is the ONE appearance of each url — the server stores only a hash, so it
 * cannot be shown again. That is why the block says so out loud instead of
 * letting the owner close the wizard and come back looking for it.
 */
function MintedLinks({ links }: { links: readonly CreateInviteResponse[] }) {
  return (
    <Stack direction="vertical" gap={0} className="border-border overflow-hidden rounded-lg border">
      <Stack
        direction="horizontal"
        gap={2}
        align="center"
        justify="between"
        className="bg-muted/40 border-border border-b px-3.5 py-2.5"
      >
        <p className="text-foreground text-sm font-medium">Link mời đã tạo</p>
        <p className="text-muted-foreground font-mono text-xs tabular-nums">
          {links.length} link
        </p>
      </Stack>

      <ul>
        {links.map((invite) => (
          <li key={invite.id} className="border-border border-b last:border-b-0">
            <MintedLinkRow invite={invite} />
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground bg-muted/20 px-3.5 py-2 text-xs leading-relaxed">
        Chép link ngay — vì lý do an toàn, hệ thống chỉ hiện mỗi link đúng một lần. Cần thêm thì tạo
        link mới ở màn Thành viên.
      </p>
    </Stack>
  );
}

function MintedLinkRow({ invite }: { invite: CreateInviteResponse }) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const roleLabel =
    ROLE_OPTIONS.find((option) => option.role === invite.role)?.label ?? invite.role;

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopiedAt(Date.now());
      window.setTimeout(() => setCopiedAt(null), 2_000);
    } catch (error) {
      // A refused clipboard (http origin, denied permission) must not look like
      // a copy that worked. The link stays selectable on screen, which is the
      // fallback — so this reports and stops rather than faking success.
      console.warn("[invite] clipboard write was refused", { inviteId: invite.id, error });
      setCopiedAt(null);
    }
  }

  const isCopied = copiedAt !== null;

  return (
    <Stack direction="horizontal" gap={3} align="center" className="px-3.5 py-2.5">
      <span className="border-border text-muted-foreground shrink-0 rounded border px-2 py-0.5 text-[11px]">
        {roleLabel}
      </span>
      {/* `select-all`: one click selects the whole link when the clipboard says no. */}
      <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs select-all">
        {invite.url}
      </code>
      <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
        {isCopied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {isCopied ? "Đã chép" : "Chép link"}
      </Button>
      {/* Announced, not just recoloured — the icon swap alone says nothing to a
          screen reader. */}
      <span role="status" aria-live="polite" className="sr-only">
        {isCopied ? "Đã chép link mời vào bộ nhớ tạm" : ""}
      </span>
    </Stack>
  );
}
