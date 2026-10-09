# Todo

Details, acceptance criteria and verification for each task are in [plan.md](plan.md). C = Claude, U = you.

## Decisions (U)
- [x] D1 Tenant erasure means anonymizing and keeping the ledger
- [x] D2 Owners must use two-step sign-in (workspace setting)
- [x] D3 Production database: Supabase Pro or bundled Postgres (accepted: Supabase Pro, own project)
- [x] D4 Virus scanning: not for launch
- [x] D5 Privacy notice: Claude drafts, a lawyer or DPO reviews

## Phase 1: code (C)
- [x] T1 Dashboard trend nets adjustments
- [x] T2 Versioned password hashes (scrypt N=2^14 r=8 p=5) with rehash on sign-in
- [x] T3 Per-account sign-in backoff (`LoginFailure` table)
- [x] T4 Owners must use two-step sign-in; `MFA_ENCRYPTION_KEY` required in production
- [x] T5 Public privacy notice page, linked from sign-in, portal and invite
- [x] T6a Tenant data export
- [x] T6b Tenant erasure (anonymize, refuse while a balance or lease is open)
- [x] T7 Pin Docker images; CI on `ubuntu-24.04` with current actions
- [ ] T8 Push and confirm CI starts on push (C+U)
- [ ] **CP1** Local and GitHub CI green, visual review, docs updated, you review the diff

## Phase 2: blockers
- [ ] B1 Production database with point-in-time recovery (U)
- [ ] B2 Generate and store encryption keys (C+U)
- [ ] B3 Server, DNS, verified email domain (U)
- [ ] B4 Staging run: smoke script, headers, browser flows (C+U)
- [ ] B5 Restore drill on PostgreSQL 17; nightly backup with alerts (C+U)
- [ ] **CP2** Go-live checklist (deployment.md §7) complete; monitoring; staging sign-off

## Phase 3: limits
- [ ] L1 One API instance (record the decision)
- [ ] L2 Virus scanning deferred (record the decision)
- [ ] L3 Ask an accountant about BIR receipts (U)
- [ ] L4 Payment gateway as a later project (U)
- [ ] **CP3** Decisions recorded in production-operations.md

## Phase 4: real tenants
- [ ] P1 Production deploy (C+U)
- [ ] P2 Owner account with two-step sign-in; staff invited (U)
- [ ] P3 Pilot property entered and reconciled (U)
- [ ] P4 Pilot tenants invited with the privacy notice (U)
- [ ] P5 First billing run and first week of backups checked; then the remaining properties (C+U)
