# Progress

## Current task

Working through `tasks/plan.md`. Phase 1 (code) is pushed (2026-10-11), and its 3 migrations are applied to the Supabase dev database. CI started by hand passed (run 38005527295), including the pinned images in the container job. Before that, all work was committed and pushed to `main` (2026-10-10). **GitHub CI passed for the first time** (run 37970550334, started manually), including the `containers` job:
- The Docker images build.
- The production stack starts and passes its proxy, readiness and PWA checks.

Pushes to `main` start CI again (fixed 2026-10-17). The remaining production blockers are listed under Next steps.

## Done (newest first)

- **2026-11-21: Deployment and workflow review.** All CI verify steps pass locally: audit 0, lint, typecheck, 66 unit, 150 e2e, 39 web, build, and 7 script tests. `check-ui.mjs` passes for every public, staff, portal and demo page at all widths in light and dark.
  - Found: `deploy/proxy.test.mjs` (Caddy headers, caching, keeping the API's sandbox CSP) had never been run by CI. It is now a `verify` step that takes Caddy from the pinned `caddy:2.11.7-alpine` image; keep that tag in step with the Dockerfile.
  - Its first run (CI 44893220557) found 3 Caddyfile bugs, now fixed (CI 44893643412 passed both jobs): Caddy replaced the API's CSP, so documents lost `sandbox` in production (now `?Content-Security-Policy`); `/` had no `no-cache`; a missing asset got `index.html` with 200, marked immutable when hashed. Now only paths without a file extension fall back to `index.html`, so app routes must not contain a dot.
  - The user woke the hibernated Supabase dev project; `20261120090000_demo_mode` is now applied there (all 19 migrations, schema up to date).
  - **The demo against Supabase from a local API fails intermittently** (4 tries: 3 failed with 500, 1 worked in 191 s).
    - Unexpected-error logs and the demo seed now include `prismaCode` (code only, never the message). A failed demo clean-up is now logged (`DEMO_CLEANUP_FAILED`) instead of being swallowed.
    - The code is **P1001** (can't reach the database), not a transaction timeout. From here, each query to the Seoul pooler takes about 140 ms (spikes up to 1.2 s), and a fresh connection takes 1.3 to 3.6 s. Prisma's default `connect_timeout` is 5 s, so when the pool opens a connection mid-seed, a slow handshake fails. The connection count was not the cause (2 `rentflow` connections open, cap 10).
    - An early failure left a demo workspace because its clean-up failed silently. All leftover demo workspaces and users were deleted by hand (0 left).
  - **Deploy constraint:** run the production API in the same region as the database (or move both closer to the Philippines). From a distant host, connections would fail the same way for real payments. For local work, the dev `DATABASE_URL` in `apps/api/.env` now has `connect_timeout=15`. With it, the demo worked end to end with no errors logged: created in 151 s; every staff read endpoint returned 200 (0.7 to 4.9 s each); a payment posted and its replay returned the same payment; a staff invite was refused with `DEMO_RESTRICTED`; signing out deleted the demo (0 left).

- **2026-11-20: Demo mode** (merged into `main` and pushed as `e01d3d1`; GitHub CI run 44622262416 passed both jobs, including `containers`; design `docs/superpowers/specs/2026-11-20-demo-mode-design.md`, plan `docs/superpowers/plans/2026-11-20-demo-mode.md`).
  - "Try the demo" on the sign-in page gives a stranger a private "Demo Rentals" workspace with sample data made through the real services. It is deleted after 24 hours by the background job. A banner links to registration. Landlord side only; the tenant portal is not part of the demo.
  - Off unless `DEMO_ENABLED=true`. `DEMO_MAX_ACTIVE` (default 25) caps live demos; 3 demos per IP per hour.
  - No email can leave a demo: `@DemoRestricted()` routes answer `DEMO_RESTRICTED`, and the mailer drops `.invalid` recipients and demo workspaces. `demo.e2e-spec` makes every signed-in route that changes data choose restricted or allowed.
  - Found while testing: parallel demo seeds hit serialization failures (409 RETRY). Demos are now created one at a time in the API process.
  - Reviewed before merge: code review, security review (no vulnerabilities), break-ui, and an Impeccable critique (26/40). Fixes from them:
    - An expired demo stops working at once. Signing out of a demo deletes it, after a "Leave the demo?" question ("Sign out" reads "Leave demo" there). One demo that fails to delete is logged and skipped, so the rest of the job still runs.
    - Sign-in says what RentFlow is and gives "Try the demo" more weight; demo errors show under the demo button. The demo banner is a calm one-line brand bar, and the demo dashboard suggests collecting the top overdue balance.
    - On phones, dashboard chart tooltips are centred on the chart so they no longer widen the page. The visual review now names the element that overflows.
  - Not done: the disabled "Sign in" button looks almost enabled in dark mode (an app-wide button style).
  - New migration `20261120090000_demo_mode` (`Organization.demoExpiresAt`). Applied to Supabase 2026-11-21.

- **2026-11-20: Dependency security update before v1 deploy.** `npm audit` had found 9 new advisories (1 high: `zod`; moderate: `nodemailer` address parsing, `fast-uri`, `ip-address`, `glob`/`minimatch`, `vitest`; low: `fastify`). Now 0.
  - `npm audit fix`, then pin bumps: `fastify` 5.12.8, `@fastify/static` 10.1.12, `@nestjs/*` 12.5.1, `@nestjs/cli` 12.0.13, `vitest` ^4.1.12.
  - All `@angular/*` moved to 22.3.0 together. With only `@angular/build` on 22.3 the lockfile split the packages, and `ng build` failed with "Cannot find module '@angular/service-worker/config'". Keep the Angular packages on one version.
  - Verified after a clean `npm ci` + `db:generate`: audit 0, lint, typecheck, 65 unit, 128 e2e, 21 web tests, build, and script tests all pass.
  - Committed (`8dfafeb`, `f5634cc`) and pushed. GitHub CI run 44562761491 passed both jobs, including `containers` (images build, the production stack starts and passes the proxy, readiness and PWA checks).

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
0a. **Before real tenants' data (lean launch, decided 2026-10-20):** launch on the Supabase **free tier**, with no paid database while there are few or no users. Upgrade as the app grows.
   - **Daily off-site backups.** Schedule `npm run db:backup` (server cron or Windows Task Scheduler) and copy the dumps off the machine. The free tier has no backups, so this is the one item that must not be skipped. It also counts as activity, which should keep the project from being paused.
   - **One restore test** of a real backup into a throwaway database.
   - **Keys:** generate `MAIL_ENCRYPTION_KEY` and `MFA_ENCRYPTION_KEY` (`openssl rand -base64 32`), and store them with the backups.
   - **Privacy:** set `PRIVACY_CONTACT_EMAIL`. The owner can be the designated DPO.
   - **Check on the live domain before inviting anyone:** sign up, reset a password, upload a document, and run `deploy/smoke.sh`. This confirms the API and `prisma migrate` connect with `sslaccept=strict` and the Supabase CA in `deploy/certs/`.
   - **Skipped for now:** Supabase Pro, point-in-time recovery, and a separate staging server.
   - **Free-tier caveats:**
     - A project with about a week of no activity is paused, and must be restored in the dashboard.
     - The project is shared with the other apps (about 60 connections in all; RentFlow's role is capped at 10).
     - Daily backups mean up to a day of entries can be lost.
   - **Upgrade when** landlords depend on it daily, losing a day of entries would hurt, the project pauses or runs out of connections, or more than one API instance is needed.
0. **Supabase follow-ups:**
   - Keep each app's role connection limit within the shared budget of about 60 connections.
   - Point the S3 upload driver at Supabase Storage.
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
