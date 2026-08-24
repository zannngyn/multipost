"use client";

import { useRouter } from "next/navigation";

import { ApiError } from "@/ui/services/api-error";
import { isSetupFinished } from "@/ui/schemas/setup-progress.schema";
import { useSetupProgress } from "@/ui/hooks/useSetupProgress";

import { FirstRunChecklist } from "./FirstRunChecklist";
import { buildStepViews } from "./setup-steps";

/**
 * The full checklist, on the overview — what the corner dock links to under
 * "Mở đầy đủ".
 *
 * Same six steps, same `buildStepViews`; the difference is room. The dock has
 * space for a title and a tick, this has space for the sentence that says WHY a
 * step is locked and what the operator gets for finishing it — which is the
 * thing somebody stuck on step three actually needs.
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
