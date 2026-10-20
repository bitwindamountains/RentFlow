# Progress

## Current task

Working through `tasks/plan.md`. Phase 1 (code) is pushed (2026-10-11), and its 3 migrations are applied to the Supabase dev database. CI started by hand passed (run 38005527295), including the pinned images in the container job. Before that, all work was committed and pushed to `main` (2026-10-10). **GitHub CI passed for the first time** (run 37970550334, started manually), including the `containers` job:
- The Docker images build.
- The production stack starts and passes its proxy, readiness and PWA checks.

Pushes to `main` start CI again (fixed 2026-10-17). The remaining production blockers are listed under Next steps.

## Done (newest first)

- **2026-10-20: Second `/ship` review, and its 3 fixes.** Committed (`ee23284`..`4f8ca03`) and pushed; GitHub CI run 39375687252 passed both jobs. Verdict: GO for staging, NO-GO for real tenants' data until Next steps 0a is done. There were no Critical or High findings. CI passed on `9e416db`.
  - **Database TLS is now verified.**
    - Prisma's built-in engine knows only `sslmode` disable, prefer and require. It treats `verify-ca` and `verify-full` as `prefer`. `require` alone accepts any certificate.
    - Production now requires `sslmode=require&sslaccept=strict` for a remote database. If the provider's CA is private, `sslcert=` must point at it by absolute path. For Supabase that is `prod-ca-2021.crt`, saved in `deploy/certs/`; `compose.managed.yaml` mounts it at `/etc/rentflow/db-certs`.
    - `postgresConnection` (the backup helper) maps these to libpq: `sslmode=verify-full`, plus `sslrootcert` set to the file or `system`.
    - The dev `.env` is not affected, since only production enforces this.
    - **Not yet tested against the real Supabase pooler.** Do that in the staging run.
  - **Retrying while blocked no longer extends the block.** A refused attempt is never checked, so `startSignInAttempt` removes its record. Test: `auth.e2e-spec` "retrying while blocked".
  - **Charge adjustments are idempotent** (`ADJUST_CHARGE`, keyed per charge). The web app sends a key per form, and the test helper sends one too.
  - **New tests:**
    - replay and conflict for charges, adjustments and deposits;
    - all three erasure refusals: balance, deposit held, pending reports;
    - the strict-TLS environment cases;
    - `scripts/backup.test.mjs`, which CI runs.
  - **Test gaps closed afterwards (same day):** these tests are now in place:
    - an expired MFA challenge, a user disabled during a challenge, and two simultaneous completions of one challenge (`mfa.e2e-spec`);
    - empty and truncated uploads (`documents.e2e-spec`, `file-store.spec`);
    - the production refusal when `MAIL_FROM` is missing.
  - **The last review items, fixed the same day:**
    - **Reset email race** (`a8a28f0`, pushed): `requestPasswordReset` runs in `prisma.serializable`. A burst of 5 requests sends one email; the old code sent 2. Test: `auth.e2e-spec` "several requests arrive at once".
    - **Postgres pinned** (`262f557`, pushed): `postgres:17.11-alpine3.24` in `compose.yaml`, `compose.prod.yaml` and CI, the same pin style as Node and Caddy.
    - **No inline styles in the web CSP:** pushed after the visual review passed (staff and portal pages at every width, light and dark, with no CSP violations).
      - The Caddy CSP is now `style-src 'self'`.
      - The 8 components with their own `styles` (payment notices, MFA settings, documents, receipt, portal home, privacy, portal access, portal repairs) now keep them in `_pages.scss`, each nested under its host tag. With no component styles, Angular injects no `<style>` tags.
      - The skeleton `style="…"` attributes became `[style.x]` bindings, which go through the CSSOM and are allowed by CSP.
      - Keep it this way: **don't add `styles:` to components**; put page styles in `_pages.scss` under the host tag.
      - `check-ui.mjs` now applies the CSP from `deploy/Caddyfile` to every page, so a violation fails the review. Its Chromium runs with `LocalNetworkAccessChecks` off, because the re-served pages otherwise count as public and can't call localhost.
      - The sandboxed CSP on served documents (`document-response.ts`) still allows inline styles. That is intended.

- **2026-10-17: Ship review's recommended fixes and missing tests.** Uncommitted. Local CI passes: 65 unit tests, 121 e2e tests, the web tests, the build, and `npm audit` with 0 issues.
  - **Security:**
    - `POST /tenants/:id/erase` has `@RateLimit(10, '15 minutes')`.
    - `RATE_LIMIT_MULTIPLIER` is validated (whole number 1–1000, through `rateLimitMultiplier()` in `environment.ts`) and refused in production. `production.e2e-spec` unsets it.
    - Production requires `sslmode=require`, `verify-ca` or `verify-full` for a database outside the private Compose network. Loopback and single-label hosts like `postgres` are exempt.
    - One password-reset email per account every 2 minutes (`RESET_EMAIL_COOLDOWN`), with the same response either way.
  - **Robustness:**
    - Erasure checks the balance inside a SERIALIZABLE transaction. `tenantBalances` takes an optional `tx`.
    - Each sign-in attempt is recorded before the password or code is checked (`startSignInAttempt`) and deleted if correct. A burst test proves at most 1 of 5 parallel attempts gets through after 9 failures; the old code let all 5 through.
  - **Tests:**
    - `security.e2e-spec` now fails if any route with an id is neither in the cross-workspace sweep nor in `IDOR_EXEMPT` (with where it is proven instead). It reads the routes from controller metadata (`routesOf` in `test/helpers.ts`). 12 missing routes were added, plus 9 more list endpoints in the leak check.
    - `portal.e2e-spec` checks every route not open to tenants for a 403 `FORBIDDEN` (more than 50 routes).
    - `settlement.e2e-spec` covers oldest-first allocation of a short payment.
    - `billing.e2e-spec` covers two reversals racing (exactly one, one ledger entry) and a void racing a payment.
    - New `jobs.e2e-spec` tests the real `JobLock` SQL: one holder at a time, takeover of an expired lock, stopping on a lost lock, and one workspace's failure not blocking the others.
  - **Still open from the test review:** see the 2026-10-20 entry, which closed the idempotency, erasure and backup-script gaps.

- **2026-10-17: Whole-app polish pass (impeccable `polish`).** Uncommitted. The visual review passed before and after: 23 routes at 1440, 768, 390 and 320 px, in light and dark.
  - **Bug:** reminder text showed raw amounts ("18000.00 overdue"), on both the Reminders page and the dashboard's "Coming up" list. A new `displayMoney()` in `common/money.ts` (₱18,000.00, exact from the decimal string, no JS number) now formats them. The staff payment-report alert email uses it too. Unit test added.
  - **Phones (≤520 px):** a trailing link or button in an `.attention-item` row now drops under the text. Before, the receipt number and the Collect buttons squeezed the text into a narrow column on Portal Payments, Reminders and the dashboard. Amount columns stay on the right.
  - **Dashboard occupancy:** the two values now line up when "Ending in 30 days" wraps.
  - **Spacing:** a `.panel-title` that ends its panel no longer adds bottom margin (Tenant portal card).
  - **Left as is:** the "Guided setup · Step 1 of 4" and "Tenant · Active" labels above headings carry real information. The sidebar ending partway down full-page screenshots is a screenshot artifact of the pinned sidebar.

- **2026-10-17: Pre-ship review (`/ship`), and the 2 launch blockers fixed.** Committed (`26f02be`, `df04e24`) and pushed. GitHub CI run 39030985742, started by hand, passed both the verify and containers jobs. The push alone still started no run.
  - **Fixed: pushes started no CI run.** This was a problem on GitHub's side, for this repo only.
    - RentFlow had never had a push-triggered run, and GitHub Actions created no check suite for pushed commits. Push runs worked in other repos on this account.
    - The workflow, Actions settings, branch filter and commit messages were all fine. Editing the workflow (adding `concurrency`) did not help.
    - Turning repo Actions off and back on fixed it: `gh api -X PUT repos/{owner}/{repo}/actions/permissions -F enabled=false`, then the same with `enabled=true -f allowed_actions=all`. The next push started run 39031566084. Do the same if it happens again.
  - **Verdict:** NO-GO for real tenant data until Next steps 0a is done; GO for staging. There were no Critical or High findings. Local CI passes: 62 unit tests, 110 e2e tests, the web tests, the build, and `npm audit` with 0 issues.
  - **Fixed: erasure left personal data behind.** Erasure now also:
    - clears `Payment.notes`;
    - replaces `PaymentNotice.rejectionReason` with neutral text (a CHECK constraint requires a reason on rejected reports);
    - resets `MaintenanceRequest.title`;
    - rewrites `IdempotencyKey.responseBody`, which kept `tenantName` and report notes forever.
    - `privacy.e2e-spec.ts` now seeds all of these. Run against the old code, it finds the name left in 4 tables.
  - **Fixed: anyone could lock an owner out.** Backoff is now counted per email and IP. At 50 failures for an email, every IP that has failed against it is refused too, but clean IPs are not. A password reset clears the block.
    - New migration `20261017090000_login_failure_source` adds `ipHash` and empties the table. Applied to Supabase dev on 2026-10-17, with no schema drift.
  - **Recommended before launch:** done on 2026-10-17, see the entry above.
  - **Test gaps from the review:**
    - an automatic every-route IDOR sweep (about 10 routes have no cross-org check, including document sharing, staff edits and session deletion);
    - tenant-role 403 checks on staff writes;
    - oldest-first allocation of a short payment;
    - races between two reversals, and between a void and a payment;
    - the job lock tested on a real database;
    - idempotency tests for charges, adjustments and deposits.
  - Accessibility (axe or Lighthouse) was not checked. Do it in the staging run.

- **2026-10-11: Polish pass (impeccable `polish`).** Uncommitted.
  - **Bug:** in the portal, Home and the current page were both highlighted in the nav. `/portal` now matches exactly, in both the sidebar and the tab bar.
  - **Sidebar:** the nav list was cut off on laptop screens, with Documents half visible and Reminders and Staff hidden. The "New rental?" prompt is now hidden below 1000 px of height (Guided setup is still on the dashboard). An overflowing list fades at the bottom until it's scrolled to the end, using a scroll-driven `--nav-fade`.
  - Removed the small labels above page headings on staff and portal pages. They repeated the workspace name already in the top bar, or the nav section. They're kept where they carry information: setup step, tenant status, receipt issuer, and the public pages.
  - Replaced typed `→`, `›` and `✓` characters with SVG icons (`.ui-icon.inline-icon` in `_base.scss`) in the dashboard, portal, sidebar, ⌘K results, toast and sign-in list.
  - Removed the gradient text on the sign-in headline and the glow on the active nav indicator.
  - Removed the floating "Sample collections" card from the sign-in page, along with its styles and motion.
  - The visual review passes (all staff and portal pages, light and dark). Web build and the 21 tests pass. Detector findings left as they are: the dynamic QR `src` is a false positive, and the spring easing on the payment-success icon is intentional.

- **2026-10-11: Motion redesign (Emil Kowalski's design-engineering rules).** Uncommitted. Styles only (`_tokens`, `_motion`, `_components`, `_pages`, `_shell`).
  - Stronger custom curves (`--ease-out` 0.23,1,0.32,1; `--ease-in-out`; `--ease-drawer`). `--ease-in` and `--ease-emphasized` are gone, so exits are ease-out and faster than entrances. Animations stay at 280 ms or less, except the phone sheet (360 ms).
  - Removed frequent decoration: page-section and table-row cascades, the icon spring, the button sheen and hover lift, the nav icon nudge, the card hover lift, the overdue dot pulse, and the floating sign-in card.
  - Navigation is a 150 ms fade instead of a slide. The dashboard tile stagger went from 45 to 30 ms. The sparkline reveal went from 1.4 s to 0.6 s. The success icon starts at scale 0.8 instead of 0.4.
  - Hover effects only apply on mouse devices (`hover: hover` and `pointer: fine`). `.menu-button` gets press feedback. The bento uses `backwards` fill, which fixes a CLAUDE.md violation (it used `both`).
  - Reduced motion keeps short opacity and colour fades but removes all movement.
  - **Added motion with a purpose:**
    - Payment steps enter from the side they sit on: Back slides in from the left (`paymentBack` signal in `app.ts`).
    - Step dots fill left to right.
    - App banners fade out instead of vanishing.
    - "Copied" on the copy buttons blurs in.
    - `<details>` disclosures open smoothly where `::details-content` is supported.
    - The Ctrl/⌘K results no longer animate, since that's a keyboard action.
  - Web build and the 21 web tests pass. The visual review (`check-ui.mjs`) has not been run.

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
  - **New migrations, applied to the Supabase dev database on 2026-10-11:** `20261011090000_login_failures`, `20261011100000_owner_mfa_requirement`, `20261011110000_tenant_erasure`.

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
   - Staging run on the real domain: smoke script, real email, and browser checks of sign-in, CSRF, MFA and PWA install/update. Confirm the API and `prisma migrate` connect with `sslaccept=strict` and the Supabase CA, and run an accessibility check (axe or Lighthouse).
   - Restore drill on PostgreSQL 17 with the real backup locations.
   - Privacy notice and a designated DPO.
   - Check that CI passed on the release commit.
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
