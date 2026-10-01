# RentFlow

An installable rental-operations PWA for Philippine landlords and property teams: properties, tenants, leases, automatic rent billing, payments with receipts, arrears, deposits, expenses, maintenance, and reports.

- **API:** NestJS 12 (Fastify), Prisma 6, PostgreSQL 17 — `apps/api`
- **Web:** Angular 22 PWA (standalone components, signals, lazy routes) — `apps/web`

## What it does

- Guided setup: property → unit → tenant → lease → first charge, created atomically
- Monthly rent posted automatically (with catch-up), prorated move-ins, rent changes, renewals, move-outs, lease expiry
- Arrears with aging buckets and grace periods; one-tap **Collect** from any overdue tenant
- Partial and back-dated payments with oldest-first allocation, acknowledgement receipts (print/share), reversals
- Charge discounts, waivers, credit notes, and voids — posted records are never edited or deleted
- Security deposits kept separate from income; expenses with per-property profit and loss; CSV export
- Maintenance work orders with a status workflow; private document uploads (or links); reminders
- Automatic emails: rent reminders to tenants (before, on, and after the due date) and lease-expiry alerts to owners and managers, on rules each workspace sets
- Staff roles (owner, manager, collector, maintenance, viewer): invite, change role, suspend, remove
- Tenant portal: tenants see what they owe and their receipts, report GCash/Maya/bank payments (with a screenshot) for staff to confirm, and request repairs
- Password reset, email verification, session management, workspace switching

## Local development

Requires Node.js 24+ and npm 11+.

```sh
cp apps/api/.env.example apps/api/.env
npm install
docker compose up -d                      # or, on Windows without Docker: npm run db:local --workspace api
npm run db:deploy --workspace api         # apply migrations
npm run dev:api                           # http://localhost:3000 (Swagger: /api/docs)
npm run dev:web                           # http://localhost:4200
```

Emails (verification, reset, invitations) are printed to the API console in development (`MAIL_PROVIDER=log`).

`npm run db:seed:test` creates or resets `demo@rentflow.local` / `RentFlowDemo!2026`. It refuses to run in production.

## Verification

```sh
npm run lint --workspace api
npm run typecheck --workspace api
npm test                                  # API unit tests + web tests
npm run test:e2e --workspace api          # API end-to-end tests on a real, disposable PostgreSQL
npm run build
npm audit --omit=dev
```

The end-to-end suite starts an embedded PostgreSQL automatically, or uses `TEST_DATABASE_URL` if set (as in CI). It covers authentication flows, an IDOR sweep across every record endpoint, role enforcement, billing and rent calculations, concurrency, and idempotency.

CI runs all of the above on every push: [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Deployment

See [docs/deployment.md](docs/deployment.md) (Docker Compose with Caddy for HTTPS) and [docs/production-operations.md](docs/production-operations.md) (how billing, security, and jobs behave in production).
