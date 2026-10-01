# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

RentFlow is a rental-operations PWA for Philippine landlords. It is an npm-workspaces monorepo:
- `apps/api` is NestJS 12 on Fastify, with Prisma 6 and PostgreSQL 17. It is ESM, so relative imports use `.js` suffixes.
- `apps/web` is Angular 22, using standalone components, signals, the new control flow, and lazy routes.
- Node 24+ and npm 11+ are required.

## Commands

Run from the repo root unless noted.

```sh
cp apps/api/.env.example apps/api/.env && npm install
docker compose up -d                       # Postgres; on Windows without Docker: npm run db:local --workspace api
npm run db:deploy --workspace api          # apply migrations
npm run dev:api                            # :3000, Swagger at /api/docs
npm run dev:web                            # :4200 (the web client targets :3000 when served on :4200)
npm run db:seed:test                       # demo@rentflow.local / RentFlowDemo!2026
```

To check your work, run the same steps as CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

```sh
npm run lint --workspace api               # oxlint (API only; web has no linter)
npm run typecheck --workspace api
npm run test --workspace api               # unit tests: src/**/*.spec.ts
npm run test:e2e --workspace api           # e2e tests: test/**/*.e2e-spec.ts against real Postgres
npm run test --workspace web -- --watch=false
npm run build
```

**Running tests**
- Run a single API test file with `npx vitest run src/common/money.spec.ts` from `apps/api`. Add `-t "<name>"` to run one test.
- For a single e2e file, use `npx vitest run --config ./vitest.config.e2e.ts test/portal.e2e-spec.ts`.
- **e2e database:** the suite starts an embedded PostgreSQL and applies the real migrations ([apps/api/test/global-setup.ts](apps/api/test/global-setup.ts)). It uses `TEST_DATABASE_URL` instead when that is set. Files run serially.
- **e2e helpers:** `test/helpers.ts` provides a `Client` that keeps the session cookie and sends the CSRF header, plus `registerOwner`, `createRental` and `lastEmail` (reads the in-memory mail outbox).
- **Windows:** a temp-folder `EBUSY` message during cleanup is noise, not a failure.

**Schema changes**
- Edit [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma), then create a migration with `npm run db:migrate --workspace api`.
- Many invariants live only in hand-written SQL in the migrations. Examples are CHECK constraints, partial unique indexes and same-organization triggers, so add these by hand to the migration.
- Postgres needs `ALTER TYPE ... ADD VALUE` in its own migration before the new value is used.

## API architecture

**Bootstrap.** [bootstrap.ts](apps/api/src/bootstrap.ts) configures Fastify for both `main.ts` and the e2e tests:
- helmet, cookies, and rate limits;
- the `/api` prefix plus URI versioning, so routes live under `/api/v1`.

The global guard and error filter are registered in `app.module.ts`. Raw-body uploads are accepted only on routes matched by the `uploadRoute` regex in `bootstrap.ts`. Add any new upload route to that regex.

**Auth: deny by default.**
- Sessions are an opaque cookie, stored hashed. Mutating requests also need the `x-csrf-token` header.
- `SessionGuard` is global. Every route must either be `@Public()` or carry `@Roles(...)`; see [auth/decorators.ts](apps/api/src/auth/decorators.ts).
- `ALL_ROLES` means staff only (OWNER, MANAGER, COLLECTOR, VIEWER, MAINTENANCE).
- `TENANT` is the portal role. A tenant membership is bound to one `tenantId`, and the database enforces this with a CHECK constraint and a partial unique index.
- `ANY_MEMBER` adds TENANT and is used only on shared auth routes. Never put TENANT on a staff route, and validate staff role inputs with `IsIn(ALL_ROLES)`.

**Multi-tenancy.**
- Every query is scoped by `organizationId` from the session. Load records with `findFirst({ where: { id, organizationId } })`; a cross-org ID must return 404.
- `rentflow_same_organization` triggers in the migrations reject cross-org foreign keys as a backstop. Add one for each new foreign key to an organization-owned table.
- Portal queries are additionally scoped to the session's `tenantId`. `test/security.e2e-spec.ts` and `test/portal.e2e-spec.ts` hold the IDOR and role sweeps; extend them when you add endpoints.

**Money and ledger.**
- Amounts cross the API as decimal strings and are parsed with `parseMoney` and formatted with `formatMoney` from [common/money.ts](apps/api/src/common/money.ts). Never use JS numbers.
- Posted records are never edited or deleted. Corrections are reversals, voids, waivers, or credit notes.
- [billing/ledger.ts](apps/api/src/billing/ledger.ts) (`postCharge`) is the single place charges are posted.
- Payments allocate oldest-first in `PaymentsService.create`.

**Transactions and idempotency.**
- Money-moving writes take an idempotency key and run through `IdempotencyService.execute({organizationId, key, operation}, input, work)` in a SERIALIZABLE transaction.
- `PaymentsService.create` accepts a `withinTransaction` hook so other modules can make extra writes atomically with the payment. Portal notice confirmation is the example.

**Errors and audit.**
- Throw `DomainError('CODE', status)` from [common/errors.ts](apps/api/src/common/errors.ts) and add the user-facing message to its `messages` map. The web client branches on `code`.
- Write audit rows with `audit(tx, {...})` inside the same transaction. Personal fields are redacted at write time.

**Modules.** Feature modules live under `src/`:
- `rentals`: properties, units, tenants, leases, guided setup
- `billing`: scheduled rent, balances, periods
- `payments`
- `work`: maintenance, documents, expenses, deposits
- `reports`: dashboard, arrears, reminders, CSV
- `staff`
- `portal`: `PortalController` for tenants under `/portal/*`; `PortalAdminController` for staff review of payment notices and portal access
- `jobs`: background billing, expiry, cleanup every 15 minutes under a DB lock; gated by `ENABLE_JOBS`
- `storage`: `FileStore` with a local or S3 driver
- `mail`: `MAIL_PROVIDER=log` prints mail to the console in development

**Config.** Environment variables are validated in [config/environment.ts](apps/api/src/config/environment.ts). Production refuses unsafe values.

**Uploads.**
- The raw request body is the file.
- The type is verified by its file signature (`sniffType`): PDF, JPEG, PNG or WebP only.
- Storage keys are generated by the server.
- Files are served only through the API, with `nosniff` and a sandbox CSP.

## Web architecture

**API calls.**
- [core/api-client.service.ts](apps/web/src/app/core/api-client.service.ts) is the only HTTP entry point. It adds credentials and CSRF and normalizes errors to `{status, code, message}`.
- It emits `changes` so open screens can refresh.
- Uploads go through `ApiClient.upload`, which sends the raw body.

**Routing and roles.**
- Routes are in [app.routes.ts](apps/web/src/app/app.routes.ts), guarded by role.
- `homeFor(role)` in `core/models.ts` sends TENANT to `/portal` and MAINTENANCE to `/maintenance`; everyone else goes to `/dashboard`.
- The nav per role is defined in `app.ts`.
- `core/models.ts` holds the shared API types.

**Pages.** Pages live in `pages/` as one standalone component each, often with inline templates. They use signals for state and the `money`, `moment` and `label` pipes.

**Styles.**
- There are no per-component stylesheets for shared UI. The global design system is SCSS partials in `src/styles/`: `_tokens`, `_base`, `_shell`, `_components`, `_pages`, `_motion`.
- Colours are tokens with light and dark themes. `ThemeService` sets `data-theme`.
- All motion must sit behind `prefers-reduced-motion: no-preference`, including view transitions and `animate.enter`/`animate.leave`.

## Docs

- [docs/deployment.md](docs/deployment.md): Docker Compose with Caddy, and the environment variables.
- [docs/production-operations.md](docs/production-operations.md): safeguards, tenant portal, background jobs, rent rules, known limitations. Update it when behaviour changes.

## Session workflow
- At the start of each session, read PROGRESS.md to see current status and next steps.
- After any major or relevant change (new feature, architecture change, important decision, bug fix, new commands), update PROGRESS.md with what was done and what's next.
- If the change affects lasting project knowledge (structure, setup, commands, conventions), also update CLAUDE.md.
- Keep CLAUDE.md concise; put task-specific details in PROGRESS.md.
- Before the user runs /clear or /compact, make sure both files are up to date.
