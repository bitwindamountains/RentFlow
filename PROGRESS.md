# PROGRESS

## Current task

Automated reminders (Phase 5) are finished on branch `auto-reminders`, which is based on `main` at `4a98125`. All checks pass. The branch is waiting for review and a merge into `main`, which is local only; nothing has been pushed.

## Done (newest first)

- 2026-10-01: Automated reminders and lease-expiry alerts (branch `auto-reminders`).
  - **Rules:** each workspace sets its own rules (`ReminderSettings`).
    - Tenant rent emails are off until turned on. The defaults are 3 days before the due date, on the due date, and 3 and 7 days after the grace period ends.
    - Staff lease-expiry alerts default to 60, 30 and 7 days before the end date.
    - Owners and managers edit the rules on the Reminders page, which also lists the last 50 sends.
  - **Sending:**
    - Each step is sent at most once: it is claimed by a unique `ReminderDelivery` row first. A failed send is retried up to 3 times.
    - Only the latest step that has arrived is sent, within 2 days of its date, so there are no stale bursts.
    - Paid balances and tenants with a pending payment report are skipped.
    - The background job sends from 08:00 in the workspace's local time.
  - **Tests:**
    - API: 47 unit and 70 e2e tests, including 7 new reminder e2e tests. A test with the at-most-once guard deliberately removed failed, as it should.
    - Web: 17 tests.
    - A browser check on desktop and on a phone in dark mode passed.
  - **Bug fixed during the work:** validated DTOs carry absent fields as `undefined`. Spreading them over existing values wipes those values; filter them out first.
- 2026-10-01: Merged `tenant-portal` into `main` locally as `4a98125`, after a full local CI run. Committed `CLAUDE.md` and `PROGRESS.md` (`f64d093`).
- 2026-10-01: Tenant portal.
  - Tenants are invited from the tenant page. The `TENANT` role is bound to one tenant record.
  - Tenants see what they owe and their receipts, report GCash/Maya/bank payments with a screenshot, and request repairs.
  - Staff confirm or reject payment reports on the Payments page. Confirming records the payment and issues the receipt in one transaction.
- 2026-10-01: Merged `deploy-readiness` into `main` (`75cf305`).
  - Restructured the API into feature modules and fixed the deployment blockers.
  - Added Docker images, a Caddy HTTPS proxy with CSP, CI, and runbooks.
  - Added the token design system, dark mode, and private document uploads (local or S3).
- 2026-09-24: UI and workflow review plus fixes (see `docs/ui-workflow-review.md`, `docs/ui-visual-review.md`).
- Baseline: RentFlow MVP (`21a388b`).

## Next steps

1. Review `auto-reminders`, then merge it into `main`. Push only when the user asks.
2. On the user's database, run `npm run db:deploy --workspace api`. Four migrations have been added since the last deploy: `document_uploads`, `tenant_role`, `tenant_portal` and `automated_reminders`.
3. Remaining roadmap gaps from `rental_manager_full_scale_plan.md`:
   - Phase 3: push notifications and property announcements.
   - Phase 5: recurring non-rent charges, if they are not already covered by billing schedules (check first).
   - Phase 6: subscriptions, trials and usage limits.
   - SMS reminders, later.
4. Items still open from `docs/ui-workflow-review.md`. Recheck each against the current code first, since some may be done:
   - Server pagination and report date filters.
   - Unit editing.
   - Scheduled move-outs and future-dated lease changes.
   - Full accessibility, device and PWA testing.
   - A verified backup restore.
5. Before scaling to more than one API instance: a shared rate-limit store, because the counters are per instance.

## Notes / decisions

- Financial records are append-only. Corrections are adjustments, voids or reversals; nothing posted is edited or deleted.
- There is no payment gateway yet. Tenants report payments and staff confirm them.
- Receipts are acknowledgement receipts, not BIR official receipts.
- Uploaded files are not virus-scanned. They are never rendered inline, and PDFs always download.
- Reminder emails are opt-in for tenant contact. Staff alerts default to on. Overdue steps count from the end of the grace period, matching arrears.
- `apps/web/scripts/check-ui.mjs` needs local Edge and a Playwright cache, so it is local-only. For ad-hoc browser checks, use playwright-core with the cached Chromium 1243 against a throwaway embedded Postgres on port 54999.
- On Windows, bash heredocs mangle backslashes and backticks. Write multi-line edit scripts to `.cjs` files with the Write tool.
- Another Claude session shares this working tree. On 2026-10-01 it checked out `main` mid-task, so check `git branch --show-current` before committing.
- Separate project in the same session: LeadHarvest (`../LeadHarvest/leadharvest`, its own git repo and CLAUDE.md). Version 0.3.0 (tech signals, batch, weekly monitor) is built but **uncommitted**. Live runs, Sheets and HubSpot checks are waiting on the owner's real `LH_USER_AGENT`. Google Places is blocked on decision D1.
