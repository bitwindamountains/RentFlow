# Production operations

Keep operations simple and explicit.

## Release safeguards

- Production startup rejects `USE_IN_MEMORY_STORE=true`; use PostgreSQL for all production records.
- Lease termination is immediate. Future termination dates are rejected using the organization's timezone; scheduled termination is not supported.
- Unconfirmed payment requests are saved before submission in browser session storage, scoped to the user and organization. Reopening Record payment in the same tab after a reload recovers the original request and idempotency key. Do not close the tab or re-enter an uncertain payment in another tab; reconcile payment history first. No credentials or session tokens are stored with the request.
- Unexpected request failures log a request identifier and stack locations, excluding exception messages and request bodies that may contain sensitive data. Forward application logs to the production logging service.
- Before deployment, run the database-backed tests with `RUN_PERSISTENCE_TESTS=true` against a dedicated test database. These tests create fixture records. Also complete the dependency audit, HTTPS staging checks, and a backup restore drill.

## Required services

Self-service password recovery is not enabled yet. Configure an approved transactional email service before implementing and enabling reset-link delivery; do not return reset tokens from a public endpoint or write them to application logs.

Existing users can accept staff invitations with their current password. Acceptance never changes an existing password, role, or suspended membership. The invitation flow preselects the invited workspace at sign-in; users can also enter its workspace ID under "Signing in to another workspace?" on the sign-in screen. Leaving this blank uses their earliest active membership.

- Managed PostgreSQL with encryption, point-in-time recovery, and daily snapshots
- HTTPS reverse proxy serving the Angular build and forwarding `/api` to NestJS
- Centralized application logs and uptime checks for `/api/v1/health/live` and `/api/v1/health/ready`

## Automated billing

Set `ENABLE_BILLING_JOBS=true` on exactly one API instance. It checks active organizations hourly and posts the current month’s eligible schedules. Database uniqueness and serializable transactions make retries safe. In a multi-instance deployment, keep this enabled on only one worker.

## Backups

Run `npm run db:backup --workspace api` with `DATABASE_URL` configured. This invokes `pg_dump` and writes a custom-format file under `apps/api/backups/`, which is ignored by Git.

Production backups should be copied to encrypted off-site storage with retention rules. Test a restore into a separate database at least quarterly; an untested backup is not considered recoverable.

## Alerts

Alert on readiness failures, repeated automatic-billing errors, HTTP 5xx rate, database storage, and backup age. Never include passwords, session cookies, invitation tokens, or document URLs in centralized logs.
