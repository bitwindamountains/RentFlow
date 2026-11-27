# RentFlow API

NestJS 12 on Fastify with Prisma 6 and PostgreSQL 17. See the [root README](../../README.md) for setup.

## Modules (`src/`)

| Module | What it owns |
| --- | --- |
| `auth` | Sign-up, sign-in, sessions, email verification, password reset, two-step sign-in (TOTP) |
| `rentals` | Properties, units, tenants, leases, guided setup |
| `billing` | Charges, automatic rent posting, discounts, waivers, credit notes, voids |
| `payments` | Payments, oldest-first allocation, receipts, reversals, security deposits |
| `portal` | Tenant portal: balances, receipts, payment reports, repair requests |
| `work` | Maintenance work orders, expenses, documents |
| `reports` | Arrears aging, profit and loss, reminders, CSV export |
| `staff` | Roles, invitations, suspension |
| `storage` | Private file storage for uploads |
| `jobs` | Background tick: posts due rent, applies credits, expires ended leases, sends queued email |
| `mail`, `notifications` | Email delivery through an outbox; emails staff about tenant portal activity |
| `demo` | Throwaway demo workspaces for the public demo |
| `health` | Liveness and readiness checks |

## Scripts

```sh
npm run start:dev       # API with reload on http://localhost:3000 (Swagger: /api/docs)
npm run db:deploy       # apply migrations
npm run db:migrate      # create a migration in development
npm run db:seed:test    # demo@rentflow.local / RentFlowDemo!2026 (refuses in production)
npm run db:backup       # database backup
npm test                # unit tests
npm run test:e2e        # end-to-end tests on a disposable PostgreSQL
npm run lint
npm run typecheck
```

Run them from `apps/api`, or from the repo root with `--workspace api`.
