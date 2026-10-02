# Progress

## Current task

The optional-features list is finished and merged into `main` locally as `ae40ec3`. Nothing has been pushed. Two things are waiting on the user:
- applying the database migrations;
- deciding whether to push.

## Done (newest first)

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

1. **User action:** apply the migrations to the local dev database. The automatic attempt was blocked by permissions.
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
