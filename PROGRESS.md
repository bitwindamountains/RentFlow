# Progress

## Current task

Working through `tasks/plan.md`: Phase 1 (code) is committed on `main` but not pushed (2026-10-11). Before that, all work was committed and pushed to `main` (2026-10-10). **GitHub CI passed for the first time** (run 37970550334, started manually), including the `containers` job:
- The Docker images build.
- The production stack starts and passes its proxy, readiness and PWA checks.

Pushes to `main` still do not start CI on their own. Start it with `gh workflow run CI`, and check the repo's Actions settings for push events. The remaining production blockers are listed under Next steps.

## Done (newest first)

- **2026-10-11: Pre-ship Phase 1 (code) done**, following `tasks/plan.md` (decisions D1–D5 accepted as recommended). Committed locally, **not pushed**.
  - T1: the dashboard trend subtracts adjustments, so it matches the Billed tile.
  - T2: versioned scrypt hashes (N=2^14, r=8, p=5, about 180 ms), upgraded at the next sign-in.
  - T3: per-account sign-in backoff (`LoginFailure`).
  - T4: `Organization.requireOwnerMfa`, on for new workspaces and off for existing ones. `MFA_ENCRYPTION_KEY` is now required in production.
  - T5: public `/privacy` notice. `PRIVACY_CONTACT_EMAIL` is required in production. **The text needs a lawyer or DPO review.**
  - T6: tenant data export, and erasure that anonymizes the tenant. The test that searches every table for leftover personal data found document names in upload audit rows, which are no longer recorded.
  - T7: Docker images pinned (`node:24.21.0-alpine3.24`, `caddy:2.11.7-alpine`); CI on `ubuntu-24.04` with v7 actions. These are untested until CI runs, since there's no Docker here.
  - **Checks:** the full local CI run passes (62 unit, 108 e2e, 21 web tests, build, audit). The visual review passes, and its screenshots led to fixing the privacy page rendering inside the app shell.
  - **Not browser-tested yet:** the forced two-step setup redirect, the owner on/off switch, and the export and erase buttons. Their API and guard logic are covered by tests; check them in the staging run (B4).
  - **New migrations, not applied to the Supabase dev database:** `20261011090000_login_failures`, `20261011100000_owner_mfa_requirement`, `20261011110000_tenant_erasure`. Run `npm run db:deploy --workspace api` before using the dev database with this code.

- **2026-10-10: Pre-ship review.** The full local CI run is green: lint, typecheck, 59 unit tests, 98 e2e tests, 19 web tests, the build, and `npm audit` with 0 issues.
  - **Code:** no Critical findings.
  - **Important:**
    - scrypt uses Node's default cost N=16384, below OWASP's N=2^17. The hash format stores no parameters, so raising it needs a versioned format and rehash-on-login.
    - Sign-in throttling is per IP only, and MFA is optional for owners.
    - There is no privacy notice and no way to export or erase a tenant's data (RA 10173).
  - **Suggestion:** the dashboard trend's `billed` does not subtract adjustments (`reports.service.ts:45`), while the tile does.
  - **Verdict:** ready for staging, not yet for real tenants' data. The blockers are operational and are listed under Next steps, item 0a.
  - `graphify-out/` (local knowledge graph) is now in `.gitignore`.

- **2026-10-10: Premium UI and motion pass, plus review fixes.**
  - **Fixes:**
    - The dashboard "Still to collect" amount contradicted the collection rate. It used all cash received this month, including payments applied to arrears. The API now returns `remainingThisMonth` on the same basis as the rate, with an e2e regression test. The badge now reads "X% of this month paid".
    - Migration `20261010090000_advisor_fixes` pins the trigger function's `search_path` and adds 4 indexes on foreign keys. Applied to Supabase; the security advisor is clean and there is no schema drift.
    - `npm audit` reports 0 issues (a dev-only `source-map-js` advisory was fixed).
    - CI gained a `workflow_dispatch` trigger. The production env example now has Supabase connection and Storage guidance.
  - **UI:**
    - Inter Variable typeface.
    - Layered shadows with an inner highlight, a canvas glow and faint grain.
    - Lit gradient primary buttons with a sheen on hover.
    - A sidebar with depth and a glowing active item.
    - SVG mask icons in place of text glyphs on 6 pages.
    - The sign-in hero has an aurora, a dot grid, gradient headline text and a floating glass preview card.
    - The dashboard has a hero sparkline and count-up money figures.
  - **Motion:**
    - Page sections and table rows enter in sequence, and icons land with a slight spring.
    - Cards get a cursor spotlight, and overdue status dots pulse.
    - The top bar lifts on scroll, and theme switches cross-fade.
    - Dialogs blur what is behind them.
  - Visual review passed on all pages at all widths, in light and dark.

- **2026-10-10: Committed and pushed the deployment-review work.** A full local CI run passed:
  - `npm audit` and Prisma validation passed. Lint, typecheck and build were clean.
  - API: 59 unit tests and 97 e2e tests passed. Web: 17 tests passed.
  - The deployment-readiness review found:
    - `db:backup` ran `pg_dump` across every schema, which fails on a shared Supabase database. Fixed: it now dumps only the `schema` named in `DATABASE_URL`.
    - `deploy/backup.sh` only works with the bundled Postgres. With `compose.managed.yaml`, use `npm run db:backup`, which needs `pg_dump` 17 or later on the host.
    - The production example uses `connection_limit=10`. On a shared Supabase role capped at 10, use 5, so migrations and `pg_dump` still fit.
    - The Supabase notes are now in `docs/deployment.md`.

- **2026-10-10: Dev database moved to Supabase** (free tier, Seoul region, PG 17).
  - The project is shared with 5–6 future apps. RentFlow has its own login role and schema, both named `rentflow`.
    - The role has `search_path=rentflow`, `statement_timeout=30s` and a limit of 10 connections.
    - The anon, authenticated and service roles have no access to the schema, so the Data API cannot reach it.
  - The connection goes through the Supavisor session pooler, because the direct host is IPv6-only.
  - All 13 migrations are applied. `/health/ready` passed, and the demo account is seeded.
  - The old local URL is kept as a comment in `.env`.
  - The Supabase security advisor flags one warning: `rentflow_same_organization` has a mutable `search_path`. This is low risk, because only the `rentflow` role can call it. Fix it in a later migration with `SET search_path FROM CURRENT`.
  - **Uncommitted work, not by this session:** about 1,100 changed lines from the deployment review (see `docs/deployment-review.md`), including 4 migrations from `20261009*`. Supabase already has these migrations applied, so commit this work and do not discard it.

- **2026-10-02: Merged `mfa` into `main`** (`ae40ec3`). The `mfa` branch also contains `portal-followups`. A full local CI run passed before the merge:
  - `npm audit` found 0 vulnerabilities.
  - Lint and typecheck were clean.
  - API: 48 unit tests and 73 e2e tests passed. Web: 14 tests passed. The build passed.
  - The migrations show no drift from the schema.
- **Visual review rebuilt** (`f3b394b`).
  - `apps/web/scripts/check-ui.mjs` now runs against the real API on a throwaway database instead of the old fixtures, which no longer matched the API.
  - It checks 22 staff, portal and public pages at four widths, in light and dark.
  - It fails on page errors, console errors, horizontal overflow, and dashboard amounts that wrap.
  - On its first run it found two real bugs, both fixed in `cdf9dd1`:
    - Wide tables pushed phone pages sideways. The cause was the screen-reader-only header escaping the table's scroll box.
    - Amounts in the small dashboard tiles broke mid-number at 320 px.
- **Two-step sign-in (MFA)** (`7cb3288` API, `77470b1` web).
  - Optional, per person, using an authenticator app (TOTP), with replay protection.
  - The secret is AES-256-GCM encrypted with the new `MFA_ENCRYPTION_KEY`.
  - Sign-in issues a 5-minute single-use challenge that allows 5 wrong codes.
  - Each account gets 10 hashed one-time recovery codes.
  - Security notices are emailed.
  - Covered by 5 e2e tests and 6 unit tests, including the RFC 6238 test vectors. A browser check passed.
- **Documents shared with tenants** (`f754c69` API, `597e40e` web).
  - New `DocumentRecord.sharedWithTenant` flag. A CHECK constraint limits sharing to documents attached to a tenant or a lease.
  - The portal has a Documents page.
  - The tenant page now also lists lease documents.
  - A test that deliberately removed the portal scope failed, as it should.
- **Staff email alerts** for tenant payment reports and repair requests (`297908e`).
  - Sent through the `OutboxEvent` table: written in the same transaction as the report, and retried with backoff.
- **Fixed a date-dependent billing test** (`da21d13`). The rent-change test only passed on the 1st of the month.
- **2026-10-01: Cleanup.** Removed what another Claude session had changed, which the user said was a mistake. The automated-reminders work started from its plan is parked on branch `auto-reminders` and is not merged.
- **2026-10-01: Dev database backup.** Made a backup copy of the local dev database, called `rentflow_backup_20261001`, in `apps/api/.data/postgres`.
- **2026-10-01:** Merged `tenant-portal` into `main` (`4a98125`). Added CLAUDE.md and this file.
- **Earlier:**
  - The tenant portal.
  - Merged `deploy-readiness`: document uploads, the Phase 2 redesign, and deployment readiness and security hardening.

## Next steps

0. **Next in `tasks/todo.md`:** T8 (push with your OK, and confirm CI starts on push and passes the new image pins), then CP1 (you review the Phase 1 diff), then Phase 2. The production env now also needs `MFA_ENCRYPTION_KEY` and `PRIVACY_CONTACT_EMAIL`.
0a. **Before real tenants' data (from the 2026-10-10 pre-ship review):**
   - Production database with backups and point-in-time recovery: Supabase Pro, or the bundled Postgres with `deploy/backup.sh`.
   - Generate `MAIL_ENCRYPTION_KEY` and `MFA_ENCRYPTION_KEY`, and back them up.
   - Staging run on the real domain: smoke script, real email, and browser checks of sign-in, CSRF, MFA and PWA install/update.
   - Restore drill on PostgreSQL 17 with the real backup locations.
   - Privacy notice and a designated DPO.
   - Start CI by hand (`gh workflow run CI`) before each release.
0. **Supabase follow-ups:**
   - Back up off-site regularly with `npm run db:backup`, because the free tier has no backups.
   - Keep each app's role connection limit within the shared budget of about 60 connections.
   - Point the S3 upload driver at Supabase Storage.
   - Upgrade to Pro before real tenants' data goes in.
1. **Superseded by Supabase.** This step is only needed for the old local DB: apply the migrations to the local dev database. The automatic attempt was blocked by permissions.
   1. Run `npm run db:local --workspace api`.
   2. In a second terminal, run `npm run db:deploy --workspace api`.

   Seven migrations are pending:
   - `deployment_readiness`
   - `document_uploads`
   - `tenant_role`
   - `tenant_portal`
   - `tenant_shared_documents`
   - `mfa_token_type`
   - `mfa`

   If a migration fails on old dev data, the backup `rentflow_backup_20261001` is available.
2. **Production:** set `MFA_ENCRYPTION_KEY` (`openssl rand -base64 32`) and back it up. Without it, two-step sign-in stays unavailable.
3. Push `main` only when the user asks.
4. **Parked `auto-reminders` branch:** keep it, merge it later, or delete it with `git branch -D auto-reminders`. If it is merged:
   - It has the same date-dependent billing test bug; take `da21d13`.
   - Its migration timestamp is `20261004090000`, which sorts before the shared-documents migration. That is fine.
5. Build the Docker images once Docker is installed. They have never been built here.
6. Not done, on purpose:
   - **Online payment gateway:** needs a provider account and keys.
   - **Shared rate-limit store:** only needed before running more than one API instance. The deployment runs one.

## Notes / decisions

- **Commits and pushes:** keep commits small and per layer (API, then web). Never push unless asked. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Portal invitations** reuse `StaffInvitation` with a `tenantId`, and the link carries `for: 'tenant'`.
- **Role sets:** staff DTOs validate roles with `IsIn(ALL_ROLES)`, so the `TENANT` role can never be granted through the staff screens.
- **Payment reports** are notices, not payments, so a tenant can never post anything to the ledger.
  - Notices older than 90 days are rejected.
  - A tenant can have at most 10 pending notices.
- **Idempotency** is scoped per organization, key and operation, not per user. Side effects such as emails go through the outbox inside the same transaction, so replays never repeat them.
- **MFA design choices:**
  - It is optional per person. Owners cannot require it for staff yet; that would be a possible next step.
  - If `MFA_ENCRYPTION_KEY` is missing in production, setup is refused rather than the server failing to start, so existing deployments keep starting.
- **Validated DTOs** carry absent fields as `undefined`. Filter them out before spreading over existing values.
- **Windows tooling:**
  - Bash heredocs and `node -e` mangle backticks and backslashes, so write multi-line edit scripts to `.cjs` files instead.
  - The e2e `EBUSY` message during cleanup is harmless.
  - Stopping a background `ng serve` or embedded Postgres with TaskStop can leave child processes behind. They hold ports or shared memory ("pre-existing shared memory block"). Check with `Get-NetTCPConnection` and `Get-CimInstance Win32_Process`, then stop only your own leftovers.
- **Visual checks:** prefer `node apps/web/scripts/check-ui.mjs`. It kills its own process tree. Never point browser checks at the dev database.
- **Pending authorization:** the Supabase and Creative Claw MCP servers need authorization through `/mcp`.
- **Known product limitations** are listed in `docs/production-operations.md`: no virus scanning of uploads, acknowledgement receipts only (not BIR official receipts), per-instance rate limits, and no payment gateway.
