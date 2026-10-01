# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

RentFlow is a rental-operations PWA for Philippine landlords. It's an npm workspaces monorepo (Node 24+, npm 11+):
- `apps/api`: NestJS 12 on Fastify, Prisma 6, PostgreSQL 17. ESM, so relative imports end in `.js`.
- `apps/web`: Angular 22, using standalone components, signals and lazy routes.

## Commands

Run these from the repo root:

```sh
npm install
cp apps/api/.env.example apps/api/.env
docker compose up -d                      # dev Postgres; without Docker: npm run db:local --workspace api
npm run db:deploy --workspace api         # apply migrations
npm run dev:api                           # http://localhost:3000, Swagger at /api/docs
npm run dev:web                           # http://localhost:4200 (talks to :3000/api/v1)
npm run db:seed:test                      # demo@rentflow.local / RentFlowDemo!2026 (refuses in production)

npm run lint --workspace api              # oxlint (web has no linter)
npm run typecheck --workspace api
npm test                                  # API unit tests + web tests
npm run test:e2e --workspace api          # API e2e against real PostgreSQL
npm run build
```

Run a single test:
- **API unit test:** from `apps/api`, run `npx vitest run src/common/money.spec.ts`. Unit specs sit next to the code as `src/**/*.spec.ts`.
- **API e2e test:** from `apps/api`, run `npx vitest run --config ./vitest.config.e2e.ts test/billing.e2e-spec.ts`. Narrow it further with `-t "<name>"`.
- **Web test:** run `npm test --workspace web -- --watch=false --include src/app/core/money.spec.ts`. This uses Angular's Vitest-based unit-test builder.

The e2e global setup (`apps/api/test/global-setup.ts`) starts an embedded PostgreSQL and applies the production migrations, unless `TEST_DATABASE_URL` is set (CI sets it). Suites run serially. `test/helpers.ts` has a `Client` that acts like a browser: it keeps the session cookie, sends the CSRF header, and adds an `Idempotency-Key` header to idempotent POSTs.

CI (`.github/workflows/ci.yml`) runs, in order: `npm audit --omit=dev`, Prisma validate and generate, lint, typecheck, API unit tests, e2e, web tests, build.

After changing `prisma/schema.prisma`, run `npm run db:migrate --workspace api` and then `npm run db:generate`.

## API architecture (`apps/api/src`)

Each feature module (`auth`, `rentals`, `billing`, `payments`, `reports`, `staff`, `work`, `portal`, `reminders`, `jobs`, `storage`, `mail`, `health`) has its own controller and service. Shared infrastructure lives in `common/`. All routes are served under `/api/v1`.

**Authorization is closed by default.**
- `auth/session.guard.ts` is a global guard. It resolves the session cookie, requires an `x-csrf-token` header on every non-GET request, and enforces `@Roles(...)`.
- A route with no role list is forbidden. Only `@Public()` skips the guard.
- The role sets are in `auth/decorators.ts`: `ALL_ROLES`, `FINANCE_READERS`, `MANAGERS`, `COLLECTORS`, `ANY_MEMBER`.
- `TENANT` is deliberately excluded from the staff role sets. Tenants reach only `/portal` and their own account endpoints.
- Inject the session with `@Auth()`.

**Multi-tenancy.**
- Every query must be scoped to `auth.organizationId`.
- Database triggers (`rentflow_same_organization`, defined in the `deployment_readiness` migration) also reject any row that references another organization's records.
- When you add a table with foreign keys to organization-owned records, add a matching trigger in its migration.
- Portal queries are scoped further, to the single tenant record bound to the portal account.
- `test/security.e2e-spec.ts` runs an IDOR sweep across every record endpoint. Extend it when you add endpoints.

**Financial rules.** These are invariants; keep them.
- Posted charges and payments are never edited or deleted. Corrections are adjustments (discount, waiver, credit note), voids or reversals, and each one writes a `LedgerEntry` and an audit entry.
- `billing/ledger.ts` `postCharge` is the single place a charge is posted. It writes the charge, the ledger debit and the audit entry in the caller's transaction. Rent is unique per lease and billing period.
- Money is a Prisma `Decimal`, stored as `numeric(19,4)` and validated to 2 decimals. Use the helpers in `common/money.ts` (`parseMoney`, `formatMoney`, `roundMoney`, which rounds half-up). Never use JS floats.
- On the web side, `core/money.ts` works in integer centavos, and money travels as decimal strings.
- Financial writes go through `PrismaService.serializable()`, which retries on P2034, so the callback must have no side effects outside the transaction.
- Payments, charges, deposits and guided setup are wrapped in `IdempotencyService.execute()`, keyed by the `Idempotency-Key` header. The stored response is replayed on a retry.

**Errors.**
- Throw `DomainError(code, status)` from `common/errors.ts` for expected business failures.
- Add a user-safe message to its `messages` map.
- The web app branches on `code`. `ErrorFilter` normalizes responses to `{ code, message }`.

**Dates.**
- Billing, overdue and lease expiry are computed in the organization's time zone, using the helpers in `common/dates.ts`.
- Billing and due days are 1–28.
- The rent rules are documented in `docs/production-operations.md`.

**Other modules.**
- `jobs/`: a background job runs every 15 minutes under a database lease. It expires leases, posts due scheduled charges with catch-up, sends automatic reminders (from 08:00 local time), and purges expired keys, tokens and sessions. `runAll(now)` takes the clock so tests can control it. It's disabled with `ENABLE_JOBS=false`, which the e2e config sets.
- `config/environment.ts`: configuration fails closed. The app won't start without `NODE_ENV`, a Postgres `DATABASE_URL`, HTTPS origins, and, in production, a real mail provider. Tests call `resetEnvironmentCache()`.
- `storage/`: private uploads in local or S3-compatible storage. File types are checked by content, and per-workspace quotas apply. The request body is the raw file, and Fastify accepts raw bodies only on routes matching `uploadRoute` in `bootstrap.ts`, so a new upload endpoint must be added there.
- `reminders/`: per-workspace reminder rules, plus at-most-once emails. Each send is claimed by a unique `ReminderDelivery` row before it goes out. The pure step logic is in `schedule.ts`. Tests call `RemindersService.run(orgId, today)` with chosen dates.
- `common/audit.ts`: redacts personal fields from audit logs.

## Web architecture (`apps/web/src/app`)

- `core/api-client.service.ts` (`ApiClient`) is the only HTTP entry point.
  - It adds credentials and the CSRF header, and normalizes errors to `{ status, code, message }`.
  - It holds the `profile` signal.
  - Its `changes` subject lets open pages refresh after writes.
- `app.routes.ts` uses a `page(path, title, roles, loader)` helper. `authGuard` checks `data.roles`. These role lists mirror the server's but are for UX only; the server enforces roles.
- Pages are in `pages/*.page.ts`. Staff pages and tenant pages (`portal-*`) are separate route trees.
- `core/payment-launcher.service.ts` stores an unconfirmed payment, with its idempotency key, in sessionStorage before sending it. Reopening the form offers a safe retry instead of a second payment.
- Styling is a global, token-based design system in `src/styles/` (`_tokens`, `_base`, `_shell`, `_components`, `_pages`, `_motion`), with light and dark themes via `ThemeService` and `data-theme`. Keep motion behind `prefers-reduced-motion: no-preference`.
- `apps/web/scripts/check-ui.mjs` is a local-only visual review that uses fixture data. It depends on a machine-specific Edge path and Playwright cache, and is not part of CI.

## Conventions

- Prettier is configured with single quotes and trailing commas. `.editorconfig` sets 2-space indentation and LF line endings.
- Never commit `.env` files. `.env.example` (root and `apps/api`) and `deploy/.env.production.example` document the variables.
- Deployment (Docker Compose with a Caddy HTTPS proxy, plus backups) is documented in `docs/deployment.md`. Runtime behavior is in `docs/production-operations.md`. The original product plan is `rental_manager_full_scale_plan.md`.
- `apps/api/README.md` is the unmodified Nest starter README. Ignore it.

## Session workflow
- At the start of each session, read PROGRESS.md to see current status and next steps.
- After any major or relevant change (new feature, architecture change, important decision, bug fix, new commands), update PROGRESS.md with what was done and what's next.
- If the change affects lasting project knowledge (structure, setup, commands, conventions), also update CLAUDE.md.
- Keep CLAUDE.md concise; put task-specific details in PROGRESS.md.
- Before the user runs /clear or /compact, make sure both files are up to date.
