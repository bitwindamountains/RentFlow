# Demo mode — design

Date: 2026-11-20. Status: awaiting approval.

## Intent

Let a stranger who lands on the sign-in page try RentFlow from the landlord's side without signing up. They should see a realistic, lived-in workspace (properties, tenants, rent due, some overdue, payments and receipts) and be able to use it for real: record a payment, add a tenant, open a receipt. Seeing it work is what convinces a landlord to register.

## Goals

- One click from the sign-in page into a private, pre-filled workspace.
- The visitor uses the real app and real rules (ledger, allocation, receipts), not a mock.
- Each visitor's demo is private to them and disappears on its own.
- A clear path from the demo to "create your own workspace".

## Non-goals

- The tenant portal (later).
- Converting a demo into a real workspace. Registering starts clean.
- Analytics on demo usage.

## Anti-goals (failure even if it "works")

- Real email leaving the system from a demo (invites, alerts, password resets). That would turn the demo into a spam relay.
- Demos crowding out real landlords on the shared free-tier Supabase project (10-connection role cap, 500 MB database).
- Demo data or demo users visible in, or mixed with, real workspaces.
- Any weakening of auth for real accounts.

## Approaches considered

- **A. Per-visitor sandbox workspace, deleted after 24 h. Chosen.** It's the real app, private, and needs no shared clean-up. Cost: creating, seeding and deleting a whole workspace, plus abuse limits.
- B. One shared workspace reset nightly. Visitors see each other's edits (junk, offensive text), or it's read-only and can't show recording a payment. Rejected.
- C. A browser-only demo with a fake API. It duplicates the ledger logic in the web app, which would drift. Rejected.

## Design

### Data model (one migration)

- `Organization.demoExpiresAt TIMESTAMPTZ NULL`. Non-null means a demo workspace; the value is when it's deleted. No separate boolean.
- Index on `demoExpiresAt` (partial, `WHERE "demoExpiresAt" IS NOT NULL`) for the clean-up and the live-demo count.
- The demo owner is a normal `User` with:
  - email `demo-<uuid>@demo.rentflow.invalid` (`.invalid` is reserved and can never receive mail);
  - an unusable password hash, so no password sign-in;
  - `emailVerifiedAt` set, so no verification prompts.
- `requireOwnerMfa = false` on demo workspaces.

### API

- `POST /api/v1/demo`. `@Public()` and `@RateLimit(3, '1 hour')` per IP, in a new `DemoModule` (`src/demo/`).
  1. Refuse with `DomainError('DEMO_UNAVAILABLE', 503)` when `DEMO_ENABLED` is off, or when live demos (`demoExpiresAt > now()`) number `DEMO_MAX_ACTIVE` or more.
  2. In one transaction: create the user, the workspace (name "Demo Rentals", `demoExpiresAt = now + 24h`), the owner membership, an audit row, and a session (reuse `AuthService.createSession`). The session expires no later than `demoExpiresAt`.
  3. Seed the sample data (below), then return the session the same way `register` does (cookie and CSRF token).
- **Config** (`environment.ts`):
  - `DEMO_ENABLED` (boolean, default `false`). An off switch for abuse without a redeploy of code; production opts in.
  - `DEMO_MAX_ACTIVE` (integer, default 25, range 1–200).
- `GET /auth/me` (or the existing session payload) includes `demoExpiresAt`, so the web app knows it's a demo.

### Sample data

Seeded through the existing services (`SetupService`, `LeasesService`, `PaymentsService`), not raw inserts, so the ledger is genuine. All dates are relative to today (Asia/Manila):

- 2 properties, about 6 units; 1 unit vacant.
- 5 tenants with Filipino-style names that are obviously fake, `@example.com` emails, and `0917 000 xxxx` phones.
- Active leases that started 2–5 months ago, so the history is visible:
  - most tenants paid in full;
  - one tenant partly paid (shows oldest-first allocation);
  - one tenant overdue by a month (shows arrears and reminders);
  - one lease ending within 30 days (shows the dashboard "ending soon").
- 1 security deposit, 1 expense, and 1 open maintenance request.

How backdated charges get posted (the billing service catch-up versus `postCharge` per period) is left to the builder. The constraint is that it uses the real posting path.

### What a demo can't do

These are refused in a demo workspace with `DomainError('DEMO_RESTRICTED', 403)`, plus a message map entry: "Not available in the demo. Create your own workspace to use this."

- Staff invitations and tenant portal invitations: they send email to addresses the visitor types.
- Document uploads: no files in the shared storage.
- Account changes: email, password, two-step sign-in, switching workspace, joining others.
- Data export and erasure: they work on fake data, but there's no reason to expose them. Builder's call to allow them instead.

Enforce this in one place: a guard or interceptor plus a `@DemoRestricted()` decorator on those routes, or the inverse. The builder picks whichever keeps deny-by-default honest; a test sweep like `security.e2e-spec` that lists every route as allowed or restricted in demo is required either way.

Belt and braces: `MailerService.enqueue` drops any message to a `*.invalid` address, or whose `organizationId` is a demo workspace. It logs `MAIL_SUPPRESSED_DEMO` and never throws.

### Clean-up

- The background job tick deletes demo workspaces whose `demoExpiresAt` has passed. Each one is deleted in its own transaction: the child tables in foreign-key-safe order, then the organization, then the demo user.
- When the live-demo cap is reached, `POST /demo` also runs the clean-up once before refusing, so a cap full of expired demos doesn't block visitors when jobs are slow.
- **Guard:** the delete function refuses any organization with `demoExpiresAt IS NULL`. It's tested.
- Jobs are gated by `ENABLE_JOBS`, which production already sets to true.

### Web

- **Sign-in page:** a secondary "Try the demo" button under the sign-in form, with the note "No sign-up. A private sample workspace, deleted after 24 hours." It's hidden when the API reports that demo mode is off: a public `GET /demo` returns `{ enabled }`, or the button can rely on the 503. Builder's call.
- Clicking it shows a loading state while the workspace is seeded (target under 3 s), then goes to `/dashboard`. On 503 or 429 it shows a friendly message: "The demo is busy right now. Try again in a little while, or create your own workspace."
- **Demo banner** on every staff page: "You're in a demo. The data is made up and is deleted in about N hours. [Create your own workspace]". The link signs out and opens registration.
- Restricted actions show the API's message through the existing error handling. Hiding the buttons is optional polish.
- Follow the CLAUDE.md style rules: no `styles:` in components, tokens, light and dark, reduced motion.

## Constraints

- The shared Supabase free tier, with the `rentflow` role capped at 10 connections. Seeding must run in a handful of transactions, not hundreds.
- The CSP and the existing auth model (CSRF, session cookie, deny-by-default guard) stay unchanged.
- Real-workspace behaviour must not change.

## Testing

- **e2e `demo.e2e-spec.ts`:**
  - creates a demo, and the dashboard shows arrears;
  - recording a payment works;
  - every restricted route returns `DEMO_RESTRICTED`;
  - no mail is enqueued;
  - the cap returns 503;
  - the per-IP limit applies;
  - clean-up deletes only expired demos and leaves a real workspace untouched;
  - with `DEMO_ENABLED` off, the endpoint returns 503.
- `security.e2e-spec` keeps passing: demo workspaces are isolated like any other.
- `privacy.e2e-spec` is unaffected.
- **Web:** a unit test for the banner and the sign-in button states.
- **Visual review:** `check-ui.mjs` gets the demo banner and the sign-in button.

## Review after building (requested)

- `/code-review` and a security pass on the diff.
- `break-ui` on the demo banner and the sign-in demo states.
- `impeccable` critique of the sign-in-to-demo flow, as a first-time visitor would see it.
- Fix what they find, then run the full CI steps.

## Left to the builder

- How backdated charges are produced (see Sample data).
- The guard shape for demo restrictions.
- Whether `GET /demo` exists or the button relies on the 503.
- The exact sample names and amounts (realistic peso rents, ₱6,500–₱18,000).
- The deletion order for clean-up, derived from the schema.
