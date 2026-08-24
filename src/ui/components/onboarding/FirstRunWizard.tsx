"use client";

import { Dialog } from "@astryxdesign/core";
import { useState } from "react";

import { useCreateTenant, useJoinTenant } from "@/ui/hooks/useTenantOnboarding";

import { WizardRail, type RailMilestone } from "./WizardRail";
import { WizardStepCreate } from "./WizardStepCreate";
import { WizardStepInvite } from "./WizardStepInvite";

/**
 * The first two minutes: found a company, then invite the people who will post
 * with you (M2.4).
 *
 * WHY A DIALOG OVER THE OVERVIEW, rather than the full-screen panel this
 * replaces: an operator who has just signed in should see the tool they signed
 * up for, not a form standing where it should be. The overview renders behind
 * this, blurred and inert — and it is FREE to render, because with no active
 * company `useActiveTenant().isResolved` is false and every tenant-scoped hook
 * is `enabled: isResolved`. Not one request goes out; the screen draws its own
 * frame and waits (spec §6).
 *
 * `purpose="required"`: Escape and backdrop are both disabled. Not to trap
 * anybody — the rail carries the two real ways out (an invite link, and sign
 * out) — but because there is genuinely nothing behind this to interact with.
 * Every tenant-scoped API answers 409 until a company exists, so a dismissible
 * dialog would leave the operator poking at a screen full of dead controls.
 *
 * NO F5 AFTERWARDS: `useCreateTenant` ends in `useAdoptActiveTenant()` — the
 * server has already moved the active-tenant cookie, the client drops its whole
 * cache and re-reads `/api/me`. By the time step 02 renders, the company is
 * live and `useCreateInvite` can mint against it; by the time this closes, the
 * boundary above has already re-rendered onto the real app.
 */
export function FirstRunWizard({
  onSignOut,
  onFinish,
}: {
  onSignOut?: () => Promise<void>;
  /** Owned by `FirstRunGate` — see the note there on why closing is latched. */
  onFinish: () => void;
}) {
  const create = useCreateTenant();
  const join = useJoinTenant();

  /**
   * Which pane is showing. Advanced ONLY from `onSuccess`, never optimistically:
   * a failed create that had already moved the wizard on would leave the
   * operator inviting people to a company that does not exist.
   */
  const [step, setStep] = useState<1 | 2>(1);
  /** Shown on the rail once step 01 lands, so the milestone names a real thing. */
  const [companyName, setCompanyName] = useState<string | null>(null);

  const milestones: readonly RailMilestone[] = [
    {
      label: "Tạo công ty",
      detail: companyName ?? "tên và đường dẫn",
      state: step === 1 ? "current" : "done",
    },
    {
      label: "Mời nhân viên",
      detail: "gửi link theo vai trò",
      state: step === 2 ? "current" : "upcoming",
    },
  ];

  return (
    <Dialog
      isOpen
      // A required dialog never asks to close; the two ways out are in the rail.
      onOpenChange={() => {}}
      purpose="required"
      width="min(64rem, 94vw)"
      maxHeight="min(46rem, 92vh)"
    >
      {/*
        No DialogHeader: the heading belongs to the STEP, changes with it, and a
        second fixed title above it would say the same thing twice. Each pane
        renders its own <h1>, which is what labels the dialog.

        Stacks under `md` — a two-column dialog on a phone is two unusable
        columns.
      */}
      <div className="flex min-h-0 flex-col md:h-full md:flex-row">
        <WizardRail
          milestones={milestones}
          onSignOut={onSignOut}
          join={{
            onSubmit: ({ invite }) => {
              // Two doors, one at a time: a stale refusal from the other one
              // must not sit under the answer to this one.
              create.reset();
              join.reset();
              // Someone who was INVITED is already a member of a company that
              // someone else set up — the invite step is not theirs to do, so
              // accepting a link goes straight into the app.
              join.mutate({ invite }, { onSuccess: onFinish });
            },
            isPending: join.isPending,
            error: join.isError ? join.error : null,
          }}
        />

        {/*
          `key` on the pane, not a transition prop: remounting is what replays
          the enter animation, and it also guarantees step 02 starts with a
          clean form state rather than step 01's leftovers.
        */}
        <div
          key={step}
          className="bg-card min-w-0 flex-1 overflow-y-auto p-6 sm:p-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-3 motion-safe:duration-200"
        >
          {step === 1 ? (
            <WizardStepCreate
              isPending={create.isPending}
              error={create.isError ? create.error : null}
              onSubmit={(values) => {
                join.reset();
                create.reset();
                create.mutate(values, {
                  // Only here: at this point `adopt()` has run, the company is
                  // active, and step 02 can mint invites against it.
                  onSuccess: (result) => {
                    setCompanyName(result.tenant.name);
                    setStep(2);
                  },
                });
              }}
            />
          ) : (
            /*
              Both buttons on step 02 end here. Closing IS the transition into
              the app: `/api/me` already carries the new membership and the
              overview behind is already loading, so there is no success screen
              in between — the proof is being inside.
            */
            <WizardStepInvite onDone={onFinish} />
          )}
        </div>
      </div>
    </Dialog>
  );
}
