# PROGRESS

## Current task

Session workflow set up (CLAUDE.md + this file) on branch `tenant-portal`. Both files are untracked; commit them with the next change.

The tenant portal is built and committed on `tenant-portal` (`3c1e578` API, `1dfeeac` web), not yet merged to `main`.

## Done (newest first)

- 2026-10-01: Added `CLAUDE.md` (commands, API/web architecture, financial and multi-tenancy invariants) and this `PROGRESS.md`. Confirmed the single web test command (`npm test --workspace web -- --watch=false --include <spec>`).
- 2026-10-01: Tenant portal (branch `tenant-portal`):
  - Tenants are invited from the tenant page. The `TENANT` role is bound to one tenant record.
  - Tenants see what they owe and their receipts, report GCash/Maya/bank payments with a screenshot, and request repairs.
  - Staff confirm or reject payment reports on the Payments page. Confirming records the payment and issues the receipt in one transaction.
- 2026-10-01: Merged `deploy-readiness` into `main` (`75cf305`):
  - Feature-module API restructure and fixes for deployment blockers.
  - Docker images, a Caddy HTTPS proxy with CSP, CI, and runbooks.
  - Token design system, dark mode, and private document uploads (local or S3).
- 2026-09-24: UI and workflow review plus fixes (see `docs/ui-workflow-review.md`, `docs/ui-visual-review.md`).
- Baseline: RentFlow MVP (`21a388b`).

## Next steps

1. Review and merge `tenant-portal` into `main` after CI passes (lint, typecheck, unit, e2e, web, build).
2. Roadmap gaps from `rental_manager_full_scale_plan.md`:
   - Phase 3 remainder: push notifications and announcements.
   - Phase 5 remainder: automated reminders and lease-expiry alerts (manual reminders exist).
   - Phase 6: subscriptions, trials and usage limits.
3. Items still open from `docs/ui-workflow-review.md`. Recheck each against the current code first, since some may be done:
   - Server pagination and report date filters.
   - Unit editing.
   - Scheduled move-outs and future-dated lease changes.
   - Full accessibility, device and PWA testing.
   - A verified backup restore.
4. Before scaling to more than one API instance: a shared rate-limit store, because the counters are per instance.

## Notes / decisions

- Financial records are append-only. Corrections are adjustments, voids or reversals; nothing posted is edited or deleted.
- There is no payment gateway yet. Tenants report payments and staff confirm them.
- Receipts are acknowledgement receipts, not BIR official receipts.
- Uploaded files are not virus-scanned. They are never rendered inline, and PDFs always download.
- `apps/web/scripts/check-ui.mjs` needs local Edge and a Playwright cache, so it is local-only.
- Separate project in the same session: LeadHarvest (`../LeadHarvest/leadharvest`, its own git repo and CLAUDE.md). Version 0.3.0 (tech signals, batch, weekly monitor) is built but **uncommitted**. Live runs, Sheets and HubSpot checks are waiting on the owner's real `LH_USER_AGENT`. Google Places is blocked on decision D1.
