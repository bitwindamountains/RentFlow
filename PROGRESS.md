# Progress

## Current task

The tenant portal is merged into `main` locally (`4a98125`) and has not been pushed. Next is applying the pending database migrations, which the user needs to run (see Next steps).

## Done (newest first)

- **2026-10-01: Cleanup.** Removed what another Claude session had changed, which the user said was a mistake:
  - It had replaced CLAUDE.md and PROGRESS.md with its own versions. Both are restored to this session's versions.
  - The automated-reminders work started from its plan is parked on branch `auto-reminders` (`e7b969c`, `a2e9f0e`). It is not merged into `main`.
- **2026-10-01: Dev database backup.** Made a backup copy of the local dev database, called `rentflow_backup_20261001`, in the same local server (`apps/api/.data/postgres`). It was taken before the migrations are applied.
- **2026-10-01: Merged `tenant-portal` into `main`** (`4a98125`) after a full local CI run: audit, lint, typecheck, 41 unit tests, 63 e2e tests, 14 web tests, and the build.
- **2026-10-01: Session workflow.** Added CLAUDE.md and this file.
- **Tenant portal** (`3c1e578` API, `1dfeeac` web):
  - New `TENANT` membership role, bound to one tenant record by a CHECK constraint and a partial unique index. Archived tenants are signed out and can't sign in.
  - Staff on the tenant's page can invite the tenant (by email, plus a copyable link), resend the invite, or revoke access.
  - Tenants can see:
    - what they owe and what is overdue;
    - their open charges and lease;
    - their receipts.
  - Tenants can report payments with up to 3 proof screenshots. Each report is a `PaymentNotice`; nothing is posted until staff confirm it.
  - Staff review the reports on the Payments page:
    - **Confirm** posts the payment and receipt atomically, idempotent with key `notice-<id>`.
    - **Not received** needs a reason, which the tenant sees.
  - Tenants can request repairs, which are tagged `reportedByTenant`.
  - Added 11 portal e2e tests. A browser walkthrough of the whole flow passed.
- **Merged `deploy-readiness` into `main`** (`75cf305`).
- **Document uploads:** private PDF, JPEG, PNG and WebP files, checked by content, stored locally or on S3, with a per-workspace quota.
- **Phase 2 redesign:** token-based SCSS design system, dark mode, bento dashboard, and motion that respects reduced-motion.
- **Deployment readiness and security hardening:**
  - Session and CSRF auth, roles denied by default.
  - Same-organization DB triggers and idempotency.
  - Fail-closed config, Docker plus Caddy deployment, CI, and e2e tests on real Postgres.

## Next steps

1. **User action:** apply the migrations to the local dev database. The automatic attempt was blocked by permissions.
   1. Start the database with `npm run db:local --workspace api`.
   2. In a second terminal, run `npm run db:deploy --workspace api`.

   Four migrations are pending: `deployment_readiness`, `document_uploads`, `tenant_role` and `tenant_portal`.

   If a migration fails on old dev data, the backup `rentflow_backup_20261001` is available. Once everything works, it can be dropped.
2. Build the Docker images once Docker is installed. They have never been built here.
3. Push `main` only when the user asks.
4. Decide what to do with the parked `auto-reminders` branch: keep it, merge it later, or delete it with `git branch -D auto-reminders`.
5. Optional future work. Each item needs the user's go-ahead:
   - an online payment gateway;
   - MFA;
   - sharing documents with tenants;
   - staff notifications for new tenant reports;
   - updating the outdated `apps/web/scripts/check-ui.mjs`;
   - a shared rate-limit store before running more than one API instance.

## Notes / decisions

- **Commits and pushes:** keep commits small and per layer (API, then web). Never push unless asked. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Portal invitations** reuse `StaffInvitation` with a `tenantId`, and the link carries `for: 'tenant'`.
- **Role sets:** staff DTOs validate roles with `IsIn(ALL_ROLES)`, so the `TENANT` role can never be granted through the staff screens.
- **Payment reports** are notices, not payments, so a tenant can never post anything to the ledger.
  - Notices older than 90 days are rejected.
  - A tenant can have at most 10 pending notices.
- **Idempotency** is scoped per organization, key and operation, not per user.
- **Windows tooling:**
  - Bash heredocs and `node -e` mangle backticks and backslashes, so write multi-line edit scripts to `.cjs` files instead.
  - The e2e `EBUSY` message during cleanup is harmless.
  - Stopping `db:local` from a background task can leave `postgres.exe` helper processes behind. Port 5432 is then closed, so they are harmless.
- **Visual checks:** use playwright-core with the cached Chromium 1243 against a throwaway embedded Postgres on port 54999. Never point them at the dev database.
- **Pending authorization:** the Supabase MCP server needs authorization through `/mcp`.
- **Known product limitations** are listed in `docs/production-operations.md`: no virus scanning of uploads, acknowledgement receipts only (not BIR official receipts), per-instance rate limits, and no payment gateway.
