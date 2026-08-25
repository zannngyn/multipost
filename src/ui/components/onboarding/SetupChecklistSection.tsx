"use client";

import { useRouter } from "next/navigation";

import { ApiError } from "@/ui/services/api-error";
import { isSetupFinished } from "@/ui/schemas/setup-progress.schema";
import { useSetupProgress } from "@/ui/hooks/useSetupProgress";

import { FirstRunChecklist } from "./FirstRunChecklist";
import { buildStepViews } from "./setup-steps";

/**
 * The setup strip on the overview — one line, not a list.
 *
 * The corner dock (SetupDock) owns the step-by-step list: it follows the
 * operator across screens, which is where that list is actually needed. So this
 * block does NOT repeat the six rows; it answers two questions for somebody who
 * just landed on the overview — how far along the company is, and which step is
 * next — and hands off to the dock for the rest.
 *
 * It disappears for good once every step is done. Nobody needs a permanent
 * monument to having finished setting up.
 */
export function SetupChecklistSection() {
  const router = useRouter();
  const query = useSetupProgress();

  // Silent for anyone the query is disabled for (editor/viewer, no company) and
  // while it is still in flight — the dock and this block must not disagree,
  // and neither may push the numbers below down for something nobody asked for.
  if (query.isPending) return null;

  /**
   * A 403 is not an error to report: it is this screen learning that the
   * operator is not an admin, which is a fact, not a fault. Anything else IS
   * reported — through the checklist's own block-error state, which offers a
   * retry when one would help (CLAUDE.md rule 5: nothing is swallowed).
   */
  if (query.isError) {
    const error = query.error;
    if (ApiError.is(error) && error.code === "FORBIDDEN") return null;

    return (
      <section id="thiet-lap" aria-labelledby="thiet-lap-title">
        <h2 id="thiet-lap-title" className="sr-only">
          Tiến trình thiết lập công ty
        </h2>
        <FirstRunChecklist
          steps={[]}
          doneCount={0}
          requiredCount={1}
          isReady={false}
          onCompose={() => router.push("/compose")}
          blockError={{
            message: ApiError.is(error)
              ? error.userMessage
              : "Không đọc được tiến trình thiết lập.",
            onRetry:
              ApiError.is(error) && error.isRetryable ? () => void query.refetch() : null,
          }}
          isLoading={false}
        />
      </section>
    );
  }

  const progress = query.data;
  if (!progress || isSetupFinished(progress)) return null;

  return (
    <section id="thiet-lap" aria-labelledby="thiet-lap-title">
      <h2 id="thiet-lap-title" className="sr-only">
        Tiến trình thiết lập công ty
      </h2>
      <FirstRunChecklist
        steps={buildStepViews(progress)}
        doneCount={progress.doneCount}
        requiredCount={progress.requiredCount}
        isReady={progress.isReady}
        onCompose={() => router.push("/compose")}
        blockError={null}
        isLoading={false}
      />
    </section>
  );
}
