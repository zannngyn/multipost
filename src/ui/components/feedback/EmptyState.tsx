import { Card, Icon, Stack, Text } from "@astryxdesign/core";
import { CircleCheck, Hourglass, Inbox, SearchX } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

/**
 * Empty state. `kind` exists to stop the classic mistake of showing the same
 * "Chưa có dữ liệu" for four different situations (core-feedback-states §Empty):
 * an operator who filtered nothing out must not think the data was lost.
 *
 * Presentational: the caller supplies the copy and the call to action.
 *
 * Shape mirrors Astryx's own EmptyState (icon, title, description, actions on a
 * muted surface) so the screens that call this one and the screens that call
 * `@astryxdesign/core`'s directly read as the same product. It is composed here
 * rather than delegated because `description` is a ReactNode and Astryx types
 * that prop as `string`.
 */
export type EmptyKind = "first-run" | "no-result" | "done" | "idle";

/**
 * The icon carries the KIND, which colour alone never could: "lọc không ra" and
 * "chưa có gì" have to be distinguishable at a glance (core-accessibility §5).
 * Decorative here — the title says the same thing in words.
 */
const KIND_ICONS: Record<EmptyKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  "first-run": Inbox,
  "no-result": SearchX,
  done: CircleCheck,
  idle: Hourglass,
};

export function EmptyState({
  kind,
  title,
  description,
  action,
  className,
}: {
  kind: EmptyKind;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    // No live region here, on purpose. A `role="status"` on this container
    // would wrap the action button too, and some screen readers re-read the
    // whole region on every DOM change inside it. It would not buy an
    // announcement either: the block mounts already filled, and a live region
    // that exists only from the moment it has content is one nothing announces.
    // Screens that need "danh sách rỗng" spoken own a live region of their own.
    <Card data-empty-kind={kind} variant="muted" padding={6} className={className}>
      <Stack direction="vertical" gap={3} align="center">
        <Icon icon={KIND_ICONS[kind]} size="lg" color="secondary" />

        <Stack direction="vertical" gap={1} align="center" maxWidth={520}>
          <Text weight="semibold" display="block" justify="center">
            {title}
          </Text>
          {/* A div, not a paragraph: callers pass fragments and lists in here,
              and a <p> may not legally contain them. */}
          <Text type="supporting" as="div" display="block" justify="center">
            {description}
          </Text>
        </Stack>

        {action ? (
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="center">
            {action}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
