"use client";

import {
  describeDetection,
  type DetectedCodeAction,
} from "@/ui/components/compose/detected-code";
import { Button } from "@/ui/components/ui/button";
import type { DetectCodeVerdict } from "@/ui/schemas/compose.schema";

/**
 * E9 — "which code the system read from the file names you just dropped".
 *
 * Draws only. Every decision — which headline, which buttons, what code each
 * one carries — lives in `describeDetection`, where a test catches it without
 * a DOM.
 */
export interface DetectedCodeNoticeProps {
  verdict: DetectCodeVerdict | null;
  warnings: readonly string[];
  onAction: (action: DetectedCodeAction) => void;
  isPending: boolean;
}

export function DetectedCodeNotice(props: DetectedCodeNoticeProps) {
  // Nothing asked yet — an empty bordered box would be noise.
  if (!props.verdict) return null;
  const view = describeDetection(props.verdict);

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border bg-card space-y-3 rounded-lg border p-3"
    >
      <p className="text-sm">{view.title}</p>

      <div className="flex flex-wrap gap-2">
        {view.actions.map((action) => (
          <Button
            key={`${action.kind}:${action.code}:${action.label}`}
            type="button"
            size="sm"
            variant={action.variant === "outline" ? "outline" : "default"}
            disabled={props.isPending}
            onClick={() => props.onAction(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>

      {props.warnings.length > 0 ? (
        <ul className="text-muted-foreground space-y-1 text-xs">
          {props.warnings.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
