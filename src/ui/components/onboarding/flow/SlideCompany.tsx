"use client";

import { Text } from "@astryxdesign/core";

import { CreateTenantForm } from "@/ui/components/tenant/CreateTenantForm";
import { JoinInviteForm } from "@/ui/components/tenant/JoinInviteForm";
import { useCreateTenant, useJoinTenant } from "@/ui/hooks/useTenantOnboarding";

/**
 * Slide 01 — the only mandatory one: without a company every tenant-scoped API
 * answers 409, so there is nothing for the other five slides to do.
 *
 * It carries the second door out of this screen, and that door is load-bearing
 * rather than decorative: an employee whose admin already sent them a link must
 * not be made to found a second company to get past it — and accepting a link
 * goes STRAIGHT into the app, skipping the whole slideshow, because the company
 * they joined was already set up by somebody else.
 *
 * SIGN-OUT MOVED OUT (two-column frame). It used to hang off the bottom of this
 * form; it now sits at the foot of the story column, where `SlideShell` draws
 * every way out of the flow. The reason it exists at all is unchanged: this
 * route is outside `AppFrame`, there is no top bar, and without it an account
 * that belongs to no company is locked in the browser with no route to /signin.
 *
 * `useCreateTenant` ends in `useAdoptActiveTenant()`: by the time `onCreated`
 * fires the cookie has moved, the cache is dropped and `/api/me` re-read, so the
 * next slide can already talk to the new company. No F5 in between.
 *
 * WHY `CreateTenantForm` DIRECTLY, not `WizardStepCreate` (deviation from the
 * plan snippet): `SlideShell` already renders this slide's single <h1> ("Tạo
 * công ty") and its lead paragraph, and `ProgressRail` already states "Bước
 * 1/6". `WizardStepCreate` brings its own <h1> plus the literal string "Bước
 * 01 / 02" — a second top-level heading on one slide (spec section 9 allows
 * exactly one) and a step counter that contradicts the rail. The shared form
 * underneath is the same one it wrapped, with the same props, so nothing is
 * duplicated: only the two-step wizard's chrome is dropped.
 *
 * Every string below declares its own colour. Nothing here inherits: Astryx's
 * `Theme` — mounted by `OnboardingFlow` — scopes `--color-text-primary` onto the
 * text elements under it, and that is the same near-black a dark surface uses as
 * its BACKGROUND (spec section 10).
 */
export function SlideCompany({
  onCreated,
  onJoined,
}: {
  onCreated: () => void;
  onJoined: () => void;
}) {
  const create = useCreateTenant();
  const join = useJoinTenant();

  return (
    <div className="flex flex-col gap-6">
      <CreateTenantForm
        hasAutoFocus
        slugDisplay="inline"
        submitLabel="Tạo công ty và tiếp tục"
        isPending={create.isPending}
        error={create.isError ? create.error : null}
        onSubmit={(values) => {
          // Two doors, one at a time: a stale refusal from the other one must
          // not sit under the answer to this one.
          join.reset();
          create.reset();
          // Advancing only from `onSuccess` — a failed create that had already
          // moved the flow on would leave the operator connecting Drive for a
          // company that does not exist.
          create.mutate(values, { onSuccess: onCreated });
        }}
      />

      {/* What founding it makes you, stated before the button is pressed rather
          than discovered afterwards. */}
      <Text type="supporting" className="text-muted-foreground text-xs">
        Bạn là chủ công ty · múi giờ GMT+7
      </Text>

      {/* The other door — the invited employee.

          A card, not a second column: the slide is one narrow measure, and the
          border is what says "this is the other door" without competing with the
          primary action above it. */}
      <section
        aria-labelledby="onboarding-join-heading"
        className="border-border bg-card text-card-foreground rounded-lg border p-4"
      >
        <h2 id="onboarding-join-heading" className="text-foreground text-sm font-semibold">
          Đã có người mời bạn?
        </h2>
        <p className="text-muted-foreground mt-1 mb-3 text-xs leading-relaxed">
          Dán link mời để vào công ty của họ — bạn không cần tạo công ty mới.
        </p>
        <JoinInviteForm
          isPending={join.isPending}
          error={join.isError ? join.error : null}
          onSubmit={({ invite }) => {
            create.reset();
            join.reset();
            join.mutate({ invite }, { onSuccess: onJoined });
          }}
        />
      </section>
    </div>
  );
}
