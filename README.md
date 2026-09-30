# RentFlow

A focused, installable rental-operations PWA for small and growing landlords.

## Included workflows

- Owner authentication, secure staff invitations, and role-based access
- Properties, units, tenants, leases, renewals, and move-out/termination
- Monthly rent schedules, safe recurring charge generation, and reminders
- Partial/full payments, allocations, receipts, reversals, and tenant ledger
- Security deposits kept separate from rental income
- Expenses, maintenance work orders, and secure document links
- Live dashboard, financial report, and transaction CSV export
- Installable Angular PWA with cached app shell and clear offline behavior

The product deliberately excludes enterprise-only complexity. Private API data and financial writes are never cached for offline use.

## Local setup

1. Copy `.env.example` to `apps/api/.env`.
2. Install packages with `npm install`.
3. Start PostgreSQL with `docker compose up -d`, or on Windows run `npm run db:local --workspace api` in a dedicated terminal.
4. Apply migrations with `npm run db:deploy --workspace api`.
5. Start the API with `npm run dev:api`.
6. Start the web app with `npm run dev:web` and open `http://localhost:4200`.

Register an owner, use **Guided setup** for the first rental, and use **Record payment** for collections. Set `ENABLE_BILLING_JOBS=true` on one API instance to generate eligible monthly charges automatically.

For a local development login, run `npm run db:seed:test`. This creates or resets an owner account for `demo@rentflow.local` with password `RentFlowDemo!2026`. The command refuses to run when `NODE_ENV=production`; override the local credentials with `TEST_ACCOUNT_EMAIL` and `TEST_ACCOUNT_PASSWORD` when needed.

## Production operations

See [docs/production-operations.md](docs/production-operations.md) for billing jobs, health monitoring, backups, and restore expectations. The API provides `/api/v1/health/live`, `/api/v1/health/ready`, and non-production OpenAPI documentation at `/api/docs`.

## Verification

- `npm test` — API and Angular unit/component tests
- `npm run test:e2e --workspace api` — isolated HTTP flow
- With PostgreSQL running, set `RUN_PERSISTENCE_TESTS=true` and run `npm run test:e2e --workspace api` — complete persistence and operations suite
- `npm run build` — API and installable PWA production bundles
- `npm run lint` and `npm audit` — static and dependency checks

## Financial integrity

- Posted financial records are append-only; corrections use reversals.
- Currency uses PostgreSQL `numeric(19,4)` and Prisma `Decimal`.
- Organization boundaries apply to all operational records.
- Retried billing and payment commands are idempotent.
- Deposits never inflate rental income.
