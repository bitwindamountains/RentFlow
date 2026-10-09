# Plan: from pre-ship review to real tenants

Source: the 2026-10-10 pre-ship review (PROGRESS.md), [docs/deployment.md](../docs/deployment.md), [docs/production-operations.md](../docs/production-operations.md). There is no SPEC.md; those docs are the spec.

Owner key: **C** = Claude can do it in the repo. **U** = needs you (accounts, money, DNS, legal). **C+U** = Claude prepares, you run or decide.

## Decisions needed before or during Phase 1

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| D1 | What does "erase a tenant" mean when the ledger must be kept? | **Anonymize, don't delete.** Replace name, email, phone and address with "Erased tenant #1234". Delete their documents and portal account. Keep amounts, dates and receipt numbers, because books of account must be kept for years under BIR rules. Refuse while a balance is open. | T6 |
| D2 | Require two-step sign-in for owners? | **Yes, for owners only, as a workspace setting that is on by default for new workspaces.** An existing owner without it is sent to set it up after sign-in and can't do anything else until it's on. | T4 |
| D3 | Production database | **Supabase Pro** (point-in-time recovery, daily backups, no pausing) in its own project, not the shared free one. Alternative: the bundled Postgres with nightly `deploy/backup.sh` and off-site copies. | B1 |
| D4 | Scan uploads for viruses? | **Not for launch.** Files are never executed or rendered inline (except images), which limits the risk. Revisit if tenants upload a lot. | L2 |
| D5 | Privacy notice text | Claude drafts it from what the app actually stores. **A lawyer or DPO should review it.** | T5 |

## Dependency graph

```
Phase 1 (code)                 Phase 2 (blockers)              Phase 3 (limits)   Phase 4 (tenants)
T1 trend fix ───────────┐
T2 versioned scrypt ────┤
T3 per-account backoff ─┤
T4 owner MFA (D2) ──────┼─► CP1 ─► B1 prod DB (D3) ─┐
T5 privacy page (D5) ───┤          B2 keys ─────────┼─► B4 staging ─► B5 restore ─► CP2 ─► L1–L4 ─► CP3 ─► P1–P5
T6 export + erase (D1) ─┤          B3 server/DNS/mail┘        ▲
T7 pin images + CI ─────┘                                     │
T8 CI on push ────────────────────────────────────────────────┘ (release gate)
```

The Phase 1 tasks are independent of each other. T3 and T4 both touch `auth.service.ts`, so do them one after the other.

## Phase 1: code fixes (all C)

Each task is one vertical slice: schema/migration if needed, API, web if needed, tests, docs. Commit per layer (API, then web), per the project convention.

### T1. Dashboard trend nets adjustments (S)
- **Change:** `reports.service.ts:45` subtracts each charge's `ChargeAdjustment` total, the same way line 32 does.
- **Accept:** after a waiver, the trend's current-month `billed` equals `billedThisMonth`.
- **Verify:** add an assertion to the existing dashboard e2e test in `test/billing.e2e-spec.ts`; check it fails before the fix.

### T2. Versioned password hashes with stronger scrypt (M)
- **Change:**
  - `common/crypto.ts`: new hashes are `s2$14$8$5$<salt>$<hash>` (log2 N, r, p). Parameters N=2^14, r=8, p=5 (OWASP-listed; 16 MB per hash, so concurrent sign-ins can't exhaust a 2 GB server).
  - `verifyPassword` reads both formats. The old `salt:hash` format means N=2^14, r=8, p=1.
  - `needsRehash(stored)`. After a successful sign-in with an old hash, `AuthService.login` stores a new hash.
  - The dummy hash for unknown emails uses the new parameters, so timing stays the same.
- **Accept:** old hashes still verify; a sign-in upgrades them; new hashes use `s2`; a tampered or unknown format fails closed.
- **Verify:** unit tests in `crypto.spec.ts` (both formats, upgrade, bad format); an e2e test that a seeded old-format user signs in and is upgraded. Measure the hash time on this machine; target under 250 ms.

### T3. Per-account sign-in backoff (M)
- **Change:**
  - New table `LoginFailure (emailHash, createdAt)` keyed by `sha256(normalized email)`, so unknown emails are tracked the same way and responses reveal nothing.
  - After 10 failures for one email in 15 minutes, `login` returns the same `INVALID_CREDENTIALS` 401 without checking the password, until the window passes.
  - A successful sign-in clears the failures.
  - The cleanup job deletes rows older than a day.
  - Also applies to `login/mfa` failures for that user.
- **Why a table, not memory:** it works across API instances, which also eases limit L1.
- **Accept:** 11 wrong passwords from rotating IPs block the 11th try with the right password; the response is identical for real and unknown emails; normal sign-in is unaffected.
- **Verify:** e2e tests in `test/auth.e2e-spec.ts` (rotate `x-forwarded-for` with `TRUST_PROXY`). Extend `test/security.e2e-spec.ts` if it holds the existing rate-limit test.

### T4. Owners must use two-step sign-in (M, needs D2)
- **Change:**
  - `Organization.requireOwnerMfa Boolean @default(true)`. The migration sets it to `false` for existing workspaces, so nobody is locked out on deploy; the owner turns it on from Account.
  - When it's on and the owner has no MFA, the session is marked `mfaSetupRequired`. The guard then allows only `/auth/me`, MFA setup, logout and sign-out routes, and answers `MFA_SETUP_REQUIRED` 403 to anything else.
  - Web: on that code, route to Account with the two-step setup open and a short explanation.
  - In production, if `MFA_ENCRYPTION_KEY` is missing, the requirement can't be met, so the API refuses to start when any workspace requires it. Or simpler: B2 makes the key mandatory in production. **Prefer the simpler one:** make the key required in production in `environment.ts`, as the mail key already is.
- **Accept:** an owner without MFA in a requiring workspace can only set it up; managers and tenants are unaffected; turning the setting off needs a password and a code.
- **Verify:** e2e tests for an owner blocked, then unblocked after setup; a role sweep showing other roles unaffected; a web unit test for the redirect.

### T5. Privacy notice (S, needs D5)
- **Change:**
  - A public `/privacy` page (standalone component, no auth guard) listing what is stored, why, who sees it, how long it's kept, and how to ask for a copy or erasure. Build the list from `schema.prisma`.
  - Linked from the sign-in page, the portal footer and the accept-invite page.
  - The workspace name and contact email come from the organization, so each landlord is shown as the controller.
- **Accept:** reachable signed out; linked from those 3 places; passes the visual review at all widths, light and dark.
- **Verify:** `check-ui.mjs` page list plus a web unit test for the route. Document it in `docs/production-operations.md`.

### T6. Tenant data export and erasure (L, needs D1)
Split into two slices:
- **T6a. Export:**
  - `GET /tenants/:id/export` (OWNER, MANAGER) returns a ZIP with JSON of the tenant, leases, charges, payments, receipts, notices and maintenance, plus their shared documents. Without a ZIP library, use JSON plus a list of document download links.
  - Audited.
  - **Accept:** contains only that tenant's records; a cross-org ID returns 404.
- **T6b. Erase:**
  - `POST /tenants/:id/erase` (OWNER only, needs a password) refuses while the tenant has an open balance or an active lease.
  - Otherwise, in one transaction: anonymize the tenant fields, end the portal membership and sessions, delete the tenant's documents through the existing storage deletion queue, clear free-text notes on notices and maintenance, and write an audit row without personal data.
  - Ledger rows stay.
  - **Accept:** after erasing, no name, email or phone of that tenant appears in any table (check with a SQL search in the test); balances, receipts and reports are unchanged; it's idempotent.
- **Verify:** e2e tests, plus IDOR and role sweeps in `security.e2e-spec.ts`; the web gets an "Export data" button and an "Erase personal data" danger action on the tenant page.

### T7. Pin images, update CI (S)
- **Change:**
  - `Dockerfile`: pin `node:24.x.y-alpine3.xx` and `caddy:2.x.y-alpine` to exact versions; add a comment on how to bump them.
  - `ci.yml`: `runs-on: ubuntu-24.04`; move `actions/checkout` and `actions/setup-node` to their current major versions (check the release pages first).
- **Accept:** CI is green with no Node 20 deprecation annotations.
- **Verify:** a manual CI run; `docker compose config` in CI still passes.

### T8. CI starts on push (S, C+U)
- **Change:** nothing is wrong in the workflow: `on: push: branches: [main]` is set, Actions is enabled, and the workflow is active. Push the Phase 1 commits (with your OK) and confirm a run starts.
- **If it doesn't start:** check the repo's Settings → Actions → General, and whether the pushes came from a token without the `workflow` scope (U).
- **Accept:** a push to `main` starts CI without `gh workflow run`.

### Checkpoint CP1
- [ ] Full local CI green (lint, typecheck, unit, e2e, web tests, build, audit).
- [ ] GitHub CI green on a push (T8).
- [ ] Visual review passes (`check-ui.mjs`) for the new pages.
- [ ] PROGRESS.md, CLAUDE.md (if conventions changed) and `docs/production-operations.md` updated.
- [ ] You review the Phase 1 diff before Phase 2.

## Phase 2: production blockers

### B1. Production database (U, needs D3)
- Create a separate Supabase Pro project (or a server for the bundled Postgres). Create the `rentflow` role and schema as in `docs/deployment.md`; turn on point-in-time recovery.
- **Accept:** `npm run db:deploy` applies all migrations; `/health/ready` is ready; the Supabase security advisor is clean.

### B2. Keys and secrets (C+U)
- **C:** a short script that prints fresh `MAIL_ENCRYPTION_KEY` and `MFA_ENCRYPTION_KEY` (and session/other secrets if any). Document that they go into a password manager **and** with the encrypted backups.
- **U:** generate, store and fill in `.env.production` on the server (readable only by the deploy user).

### B3. Server, domain and email (U)
- A Linux server with Docker (2 vCPU / 2 GB). A DNS `A`/`AAAA` record for the app subdomain; ports 80 and 443 open.
- Resend (or SMTP) with the domain verified (SPF, DKIM, DMARC).

### B4. Staging run on the real domain (C+U)
1. **U:** deploy with `docker compose -f compose.prod.yaml [-f compose.managed.yaml] --env-file .env.production up -d --build`.
2. **C:** run `deploy/smoke.sh` against the domain. Check securityheaders.com for CSP, HSTS and frame protection.
3. **C, with Playwright against the staging URL:** register, verify email (real inbox, U), sign in, check CSRF on a write, turn on two-step sign-in, sign out and in with a code and with a recovery code, reset a password, install the PWA, deploy a trivial change and see "Reload now", and run the tenant portal invite → payment report → staff confirm flow.
4. **Accept:** all the steps pass; the console is clean; no 5xx in the API logs.

### B5. Restore drill on PostgreSQL 17 (C+U)
- Back up staging (`npm run db:backup` or `deploy/backup.sh`, plus the uploads), restore it into a scratch database, point a staging API at it, and compare the dashboard totals and one receipt.
- Schedule the nightly backup (cron) with an alert on failure and on stale backups.
- **Accept:** the totals match; a document opens from the restored uploads; a backup-age alert fires when a backup is missing.

### Checkpoint CP2
- [ ] Every item in `docs/deployment.md` §7 ("Security checklist before going live") is checked.
- [ ] Uptime checks on `/health/live` and `/health/ready`, and log alerts for the events in §6.
- [ ] You sign off on staging.

## Phase 3: limits (decide, mostly no code)

| # | Limit | Plan |
|---|---|---|
| L1 | Rate limits are per API instance | **Keep one instance.** T3 already makes the important limit (per account) shared through the database. Revisit only if you add a second instance; then add `@fastify/rate-limit`'s Redis store. |
| L2 | No virus scanning (D4) | Not for launch. If needed later: a ClamAV sidecar scanning before `StorageObject` is committed. |
| L3 | Receipts are not BIR official receipts | **U:** ask an accountant whether landlords need BIR-registered receipts (most do, through their own ORs). Keep the app's receipts labelled "Acknowledgement receipt". No code. |
| L4 | No online payment gateway | Later, as a separate project (for example PayMongo or Xendit for GCash and Maya). It needs a merchant account (U). |
| L5 | Shared free Supabase for dev | Fine for dev only. Production is on B1. |

### Checkpoint CP3
- [ ] Each limit has a recorded decision in `docs/production-operations.md`.

## Phase 4: real tenants

### P1. Production deploy (C+U)
The same steps as B4, on the production database, with the backups from B5 already running.

### P2. Owner setup (U, Claude assists)
Register the owner, turn on two-step sign-in (required by T4), and invite staff with the least role each needs.

### P3. Pilot property (U)
- Enter one property with guided setup: units, tenants, leases, opening balances.
- Compare the dashboard against your current records for that property.

### P4. Invite pilot tenants (U)
- Send the privacy notice link (T5) with the portal invitation.
- A tenant reports a payment; staff confirm it; the receipt is emailed.

### P5. First month watch (C+U)
- After the first automatic billing run: the charges match the leases; reminders and overdue flags are correct.
- After one week: backups exist off-site and a restore of the newest one works.
- Then add the remaining properties.

## Risks

| Risk | Mitigation |
|---|---|
| T4 locks owners out on deploy | Existing workspaces start with the requirement off; an owner turns it on. |
| T6b erases something the books need | Anonymize only, refuse while a balance or lease is open, keep all ledger rows; tested with a SQL search for leftover personal data. |
| T2 makes sign-in slow on a small server | p=5 at N=2^14: same memory as today, about 5× CPU. Measure before merging; the sign-in rate limit caps the load. |
| Free-tier database used in production by mistake | B1 is a separate project; the env example says so; CP2 checks it. |
| Email lands in spam | Domain verification in B3; B4 tests a real inbox. |
