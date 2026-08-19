-- M1.1 backfill: turn the legacy access registry + the orphan `app_user` rows
-- into account / identity / membership (docs/09 §3.1, doc 10 §8.11).
--
-- WHY IT LIVES IN A MIGRATION AND NOT IN A SCRIPT: from M1.2 the session lookup
-- is `identity.session_email`. A deployment that ran the DDL and forgot the
-- script would come up with the new schema and nobody able to sign in. The
-- migration runner is the only channel that is ordered, exactly-once and part of
-- the release. Every statement below is nevertheless idempotent (guarded by
-- NOT EXISTS / ON CONFLICT), so re-running it by hand is a no-op.
--
-- `access_request` IS NOT TOUCHED — it stays as history (doc 10 §4.4).

--> statement-breakpoint
-- 1a. One account + one identity per PROVIDER IDENTITY found in the registry.
--
-- Grouping key is `(provider, provider_account_id)`, not the e-mail: a Google
-- address can change while `sub` stays, and two registry rows for one person in
-- two tenants must not become two people. `session_email` is then taken from the
-- MOST RECENT row — that is the address the person's JWT carries today.
--
-- `deduped` is the second net: `identity.session_email` is globally unique, so
-- if two different provider identities somehow claim one address we may only
-- keep one. The dropped one is reported by the DO block at the end instead of
-- failing the migration — a login that never happens is better than a release
-- that cannot deploy, and a silent drop is worse than both.
--
-- status: blocked WINS across every tenant. A person banned anywhere must not
-- come out of the backfill able to sign in.
WITH by_identity AS (
	SELECT
		ar."provider" AS provider,
		ar."provider_account_id" AS provider_account_id,
		(array_agg(lower(ar."session_email") ORDER BY ar."requested_at" DESC, ar."id" DESC))[1] AS session_email,
		(array_agg(ar."email" ORDER BY (ar."email" IS NULL), ar."requested_at" DESC, ar."id" DESC))[1] AS email,
		(array_agg(ar."display_name" ORDER BY (ar."display_name" IS NULL), ar."requested_at" DESC, ar."id" DESC))[1] AS display_name,
		CASE WHEN bool_or(ar."status" = 'blocked') THEN 'suspended' ELSE 'active' END AS status
	FROM "access_request" ar
	GROUP BY ar."provider", ar."provider_account_id"
),
deduped AS (
	SELECT DISTINCT ON (b.session_email) b.*
	FROM by_identity b
	ORDER BY b.session_email, b.provider, b.provider_account_id
),
fresh AS MATERIALIZED (
	SELECT d.*, gen_random_uuid() AS account_id
	FROM deduped d
	WHERE NOT EXISTS (SELECT 1 FROM "identity" i WHERE i."session_email" = d.session_email)
	  AND NOT EXISTS (
		SELECT 1 FROM "identity" i
		WHERE i."provider" = d.provider AND i."provider_account_id" = d.provider_account_id
	  )
),
ins_account AS (
	INSERT INTO "account" ("id", "status", "display_name")
	SELECT f.account_id, f.status::"public"."account_status", f.display_name
	FROM fresh f
)
INSERT INTO "identity" ("account_id", "provider", "provider_account_id", "session_email", "email")
SELECT f.account_id, f.provider, f.provider_account_id, f.session_email, f.email
FROM fresh f;
--> statement-breakpoint
-- 1b. APPROVED rows become memberships; pending and blocked rows deliberately do
-- not (states NoMembership / banned, docs/09 §3.8).
--
-- The `account.status='active'` guard is what makes "blocked wins across tenants"
-- (step 1a) actually bite: approved in tenant A + blocked in tenant B is ONE
-- suspended account, and it must come out of here with NO active membership
-- anywhere. Suspending the account but leaving an admin membership behind would
-- hand the ban back the moment someone lifts the suspension for another reason.
-- Same guard, same reason, in steps 2c and 3.
--
-- Role: the registry row is the decision of record, but `access_request.role` is
-- nullable even on an approved row (a block clears it and a re-approval may race)
-- — fall back to the role the `app_user` row is actually running with, and only
-- then to `viewer`, which is the choice that cannot hand out more than the person
-- already had.
INSERT INTO "membership" ("tenant_id", "account_id", "role")
SELECT DISTINCT ON (ar."tenant_id", i."account_id")
	ar."tenant_id",
	i."account_id",
	COALESCE(ar."role", u."role", 'viewer'::"public"."user_role")
FROM "access_request" ar
JOIN "identity" i
	ON i."provider" = ar."provider" AND i."provider_account_id" = ar."provider_account_id"
JOIN "account" a ON a."id" = i."account_id"
LEFT JOIN "app_user" u
	ON u."tenant_id" = ar."tenant_id" AND lower(u."email") = lower(ar."session_email")
WHERE ar."status" = 'approved'
  AND a."status" = 'active'
ORDER BY ar."tenant_id", i."account_id", ar."decided_at" DESC NULLS LAST, ar."id" DESC
ON CONFLICT ON CONSTRAINT "membership_tenant_account_uq" DO NOTHING;
--> statement-breakpoint
-- 2a. Operators that never went through the registry — the env-bootstrap ones
-- (`dev@localhost`, the seeded demo user, anyone created before E1.4). They can
-- sign in TODAY, so leaving them without an account would make M1.2 lock out the
-- only people using the system.
--
-- We know their session address (`app_user.email` is exactly what
-- `getOperatorSession` looks up) but not their provider id, so we mint a stable
-- placeholder from the address. Facebook rows are recognisable by the synthetic
-- `fb-<id>@facebook.local` form and get their real id back.
-- DISTINCT ON (email): the same person may already operate two tenants — one
-- account, two memberships (step 2c), not two people.
--
-- EVERY comparison folds case. `app_user.email` is only lower-cased by
-- convention (the writers do it; the column does not), while
-- `identity.session_email` is lower-cased by contract because the M1.2 lookup
-- normalises the JWT address before querying. One stray `Alice@x.com` row
-- compared verbatim would miss the existing identity, mint a SECOND account for
-- the same human, and store a capitalised `session_email` that the lookup can
-- never match — a tenant silently missing from her list, with no error anywhere.
WITH cand AS (
	SELECT DISTINCT ON (lower(u."email"))
		lower(u."email") AS session_email,
		u."name" AS display_name,
		(CASE WHEN lower(u."email") LIKE 'fb-%@facebook.local' THEN 'facebook' ELSE 'google' END)::"public"."access_provider" AS provider,
		(CASE
			WHEN lower(u."email") LIKE 'fb-%@facebook.local'
				THEN substring(lower(u."email") from 4 for position('@' in lower(u."email")) - 4)
			ELSE 'legacy-app-user:' || lower(u."email")
		END) AS provider_account_id
	FROM "app_user" u
	WHERE u."account_id" IS NULL
	ORDER BY lower(u."email"), u."created_at", u."id"
),
fresh AS MATERIALIZED (
	SELECT c.*, gen_random_uuid() AS account_id
	FROM cand c
	WHERE NOT EXISTS (SELECT 1 FROM "identity" i WHERE i."session_email" = c.session_email)
	  AND NOT EXISTS (
		SELECT 1 FROM "identity" i
		WHERE i."provider" = c.provider AND i."provider_account_id" = c.provider_account_id
	  )
),
ins_account AS (
	INSERT INTO "account" ("id", "display_name")
	SELECT f.account_id, f.display_name FROM fresh f
)
INSERT INTO "identity" ("account_id", "provider", "provider_account_id", "session_email", "email")
SELECT
	f.account_id,
	f.provider,
	f.provider_account_id,
	f.session_email,
	-- Facebook never guaranteed an address; the synthetic one is not an e-mail.
	CASE WHEN f.provider = 'facebook' THEN NULL ELSE f.session_email END
FROM fresh f;
--> statement-breakpoint
-- 2b. Link every `app_user` to its person, matching case-insensitively for the
-- reason spelled out in 2a. `app_user.email` IS the session address the running
-- sign-in gate resolves by, so this is the relation the system already uses
-- today, written down. `identity.session_email` is globally
-- unique, so an `app_user` matches at most one account, and `app_user` is unique
-- per (tenant, email), so an account matches at most one row per tenant — the new
-- UNIQUE (tenant_id, account_id) cannot be violated here.
UPDATE "app_user" u
SET "account_id" = i."account_id", "updated_at" = now()
FROM "identity" i
WHERE u."account_id" IS NULL AND lower(u."email") = i."session_email";
--> statement-breakpoint
-- 2c. Membership for the linked operators that 1b did not cover (no registry row).
-- The suspended guard is load-bearing: `decide('blocked')` does NOT delete the
-- `app_user` row it created on an earlier approval, so a banned person still has
-- one — granting membership from `app_user` alone would silently re-admit them.
INSERT INTO "membership" ("tenant_id", "account_id", "role")
SELECT u."tenant_id", u."account_id", u."role"
FROM "app_user" u
JOIN "account" a ON a."id" = u."account_id"
WHERE u."account_id" IS NOT NULL
  AND a."status" = 'active'
  AND NOT EXISTS (
	SELECT 1 FROM "membership" m
	WHERE m."tenant_id" = u."tenant_id" AND m."account_id" = u."account_id"
  )
ON CONFLICT ON CONSTRAINT "membership_tenant_account_uq" DO NOTHING;
--> statement-breakpoint
-- 3. The other half of the invariant "one active membership ↔ one app_user"
-- (docs/09 §3.2): an approved registry row whose `app_user` was deleted would
-- otherwise leave a member with no audit subject to attribute drafts to.
INSERT INTO "app_user" ("tenant_id", "account_id", "email", "name", "role")
SELECT DISTINCT ON (m."tenant_id", m."account_id")
	m."tenant_id",
	m."account_id",
	i."session_email",
	COALESCE(a."display_name", i."session_email"),
	m."role"
FROM "membership" m
JOIN "account" a ON a."id" = m."account_id"
JOIN "identity" i ON i."account_id" = a."id"
WHERE m."status" = 'active'
  -- Never mint a domain actor for a suspended person (see step 1b).
  AND a."status" = 'active'
  AND NOT EXISTS (
	SELECT 1 FROM "app_user" u
	WHERE u."tenant_id" = m."tenant_id" AND u."account_id" = m."account_id"
  )
ORDER BY m."tenant_id", m."account_id", i."created_at", i."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 4. audit_log: fill in only what the data PROVES. A row naming a user was
-- written by that user; a row naming nobody could be the worker or an operator we
-- failed to resolve, and an append-only trail must not be given a guess.
UPDATE "audit_log" SET "actor_kind" = 'user'
WHERE "actor_user_id" IS NOT NULL AND "actor_kind" IS NULL;
--> statement-breakpoint
-- 5. MYSP's own tenant runs on the `internal` plan — no AI spend ceiling
-- (doc 10 §8.9). The slug is only taken if nobody else already holds it.
UPDATE "tenant"
SET "plan" = 'internal',
	"slug" = COALESCE("slug", (
		SELECT 'demo' WHERE NOT EXISTS (SELECT 1 FROM "tenant" t2 WHERE t2."slug" = 'demo')
	)),
	"updated_at" = now()
WHERE "id" = '00000000-0000-0000-0000-000000000001'
  AND (
	"plan" <> 'internal'
	-- Only when the slug is still gettable: re-running against a database where
	-- another tenant owns `demo` would otherwise churn `updated_at` forever.
	OR ("slug" IS NULL AND NOT EXISTS (SELECT 1 FROM "tenant" t2 WHERE t2."slug" = 'demo'))
  );
--> statement-breakpoint
-- 6. Report what could not be migrated. Silence would mean an operator finds out
-- at M1.2 by being unable to sign in (CLAUDE.md rule 5: nothing is skipped quietly).
DO $$
DECLARE
	dropped_identities bigint;
	memberless_approved bigint;
	roleless_approved bigint;
	banned_elsewhere bigint;
BEGIN
	SELECT count(*) INTO dropped_identities
	FROM (SELECT DISTINCT ar."provider", ar."provider_account_id" FROM "access_request" ar) x
	WHERE NOT EXISTS (
		SELECT 1 FROM "identity" i
		WHERE i."provider" = x."provider" AND i."provider_account_id" = x."provider_account_id"
	);

	-- Deliberate skips (step 1b's suspended guard) are reported separately: mixing
	-- them into "produced no membership" would either hide a real data loss in the
	-- noise or cry wolf about a ban working as designed.
	SELECT count(*) INTO banned_elsewhere
	FROM "access_request" ar
	JOIN "identity" i
		ON i."provider" = ar."provider" AND i."provider_account_id" = ar."provider_account_id"
	JOIN "account" a ON a."id" = i."account_id"
	WHERE ar."status" = 'approved' AND a."status" = 'suspended';

	SELECT count(*) INTO memberless_approved
	FROM "access_request" ar
	WHERE ar."status" = 'approved'
	  AND NOT EXISTS (
		SELECT 1 FROM "identity" i
		JOIN "account" a ON a."id" = i."account_id"
		WHERE i."provider" = ar."provider"
		  AND i."provider_account_id" = ar."provider_account_id"
		  AND a."status" = 'suspended'
	  )
	  AND NOT EXISTS (
		SELECT 1 FROM "identity" i
		JOIN "membership" m ON m."account_id" = i."account_id" AND m."tenant_id" = ar."tenant_id"
		WHERE i."provider" = ar."provider" AND i."provider_account_id" = ar."provider_account_id"
	  );

	SELECT count(*) INTO roleless_approved
	FROM "access_request" ar WHERE ar."status" = 'approved' AND ar."role" IS NULL;

	IF dropped_identities > 0 THEN
		RAISE WARNING 'M1.1 backfill: % provider identity(ies) got no identity row (session_email already claimed) — those people cannot sign in until an admin re-invites them', dropped_identities;
	END IF;
	IF memberless_approved > 0 THEN
		RAISE WARNING 'M1.1 backfill: % approved access_request row(s) produced no membership', memberless_approved;
	END IF;
	IF banned_elsewhere > 0 THEN
		RAISE WARNING 'M1.1 backfill: % approved access_request row(s) got NO membership on purpose — the person is blocked in another tenant, so the account is suspended', banned_elsewhere;
	END IF;
	IF roleless_approved > 0 THEN
		RAISE WARNING 'M1.1 backfill: % approved access_request row(s) had no role; membership role fell back to app_user role or viewer', roleless_approved;
	END IF;
END $$;
