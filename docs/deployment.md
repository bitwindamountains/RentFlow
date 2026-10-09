# Deploying RentFlow

RentFlow ships as three containers built from the root `Dockerfile`:

| Target | Role |
| --- | --- |
| `web` | Caddy: automatic HTTPS, serves the PWA, proxies `/api/*` to the API, sets CSP/HSTS and cache headers |
| `api` | NestJS API (non-root, production dependencies only) |
| `migrate` | Runs `prisma migrate deploy` once per release, before the API starts |

PostgreSQL 17 is required. A managed database with point-in-time recovery (e.g. DigitalOcean, AWS RDS, Supabase Postgres, Neon) is strongly recommended over the bundled container.

For a managed database, set `DATABASE_URL` to that service and add `-f compose.managed.yaml` to every Compose command below (Compose 2.24.4+). This disables the bundled database and removes the migration dependency on it. Keep `POSTGRES_PASSWORD` set to an unused placeholder because the base file still interpolates it; no bundled database runs in this mode. Use the provider's backups instead of the bundled database backup script.

**Supabase, or any database shared with other apps:**
- **Own role and schema:** give RentFlow its own login role and its own schema, for example `rentflow`, never `public`.
  - Set `alter role rentflow set search_path = rentflow`, because raw SQL in the API uses unqualified table names.
  - Add `?schema=rentflow&sslmode=require` to `DATABASE_URL`.
- **Connection:** connect through the Supavisor session pooler (`<role>.<project-ref>@aws-0-<region>.pooler.supabase.com:5432`). It serves both the API and `prisma migrate`. The direct `db.<ref>.supabase.co` host is IPv6-only.
- **Connection budget:** set `connection_limit` so the API pool, plus one connection for migrations and one for `pg_dump`, stays under the role's connection limit.
- **Statement timeout:** a role-level `statement_timeout` also applies to migrations. Raise it for a release whose migration backfills large tables.
- **Backups:** `npm run db:backup --workspace api` dumps only the schema named in `DATABASE_URL`. It needs `pg_dump` 17 or later. The Supabase free tier has no backups, so schedule this command.

## 1. Prerequisites

- A Linux server with Docker Engine and the Compose plugin (2 vCPU / 2 GB RAM is plenty for hundreds of units).
- A domain name with an `A`/`AAAA` record pointing at the server; ports 80 and 443 open.
- An email provider: [Resend](https://resend.com) (`MAIL_PROVIDER=resend`) or any SMTP service (`MAIL_PROVIDER=smtp`). The API refuses to start in production without one, because password reset and invitations depend on it.

## 2. Configure

```sh
cp deploy/.env.production.example .env.production
# edit .env.production: SITE_ADDRESS, WEB_ORIGIN, DATABASE_URL, POSTGRES_PASSWORD, mail settings
```

The API validates its configuration at startup and exits with a clear message if anything is missing or unsafe. It rejects:

- a missing `NODE_ENV` or `DATABASE_URL`;
- a non-HTTPS `WEB_ORIGIN` or `APP_URL`, or an origin containing credentials, query parameters or a fragment;
- `MAIL_PROVIDER=log` in production.
- a missing or invalid `MAIL_ENCRYPTION_KEY` in production.

| Variable | Notes |
| --- | --- |
| `WEB_ORIGIN` | Exact public origin(s), comma-separated, `https://` only |
| `APP_URL` | HTTPS origin for links in emails (defaults to the first `WEB_ORIGIN`) |
| `DATABASE_URL` | Add `connection_limit=10` (or your pooler's limit) |
| `TRUST_PROXY` | Number of reverse proxies in front of the API (`1` with the bundled Caddy). Rate limiting keys on the client IP this reveals. |
| `ENABLE_JOBS` | Billing, lease expiry, and file cleanup every 15 minutes; queued email every 30 seconds. Database leases/claims coordinate instances. Keep enabled for recovery after outages. |
| `MAIL_ENCRYPTION_KEY` | Required in production: 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts queued email, including one-time links. Use the same stable key on every API instance and preserve it with encrypted backups. Do not replace it while messages are pending. |
| `SESSION_ABSOLUTE_HOURS` / `SESSION_IDLE_MINUTES` | Default 12 h absolute, 120 min idle |
| `STORAGE_DRIVER` | `local` (default: the `uploads` volume at `STORAGE_DIR=/data/uploads`) or `s3` (any S3-compatible bucket; see the example env file). The bucket must be **private**; files are only served through the API. |
| `UPLOAD_MAX_MB` / `STORAGE_QUOTA_MB` | Per-file limit (default 10 MB) and per-workspace total (default 2 GB) |
| `MFA_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). It encrypts authenticator-app secrets for two-step sign-in. Without it, people cannot turn on two-step sign-in. Keep a copy with your backups: if it is lost, accounts with two-step sign-in can only sign in with recovery codes until an admin clears `mfaSecret`. |

## 3. Launch

```sh
docker compose -f compose.prod.yaml --env-file .env.production up -d --build
docker compose -f compose.prod.yaml --env-file .env.production logs -f api
```

Check `https://<your-domain>/api/v1/health/ready` → `{"status":"ready"}`, then open the site and register the owner account.

## 4. Releasing an update

```sh
git pull
docker compose -f compose.prod.yaml --env-file .env.production up -d --build
```

`migrate` runs before `api` starts. Migrations are forward-only; take a backup first (below). Installed PWAs detect the new version and offer **Reload now**.

The review-fix release adds four migrations: `20261009090000_durable_operations`, `20261009100000_storage_reservations`, `20261009110000_durable_mail`, and `20261009120000_history_pagination`. They retain operation keys, persist staff-alert progress, backfill storage accounting from recorded documents, create the encrypted mail queue, and index paginated histories. Set `MAIL_ENCRYPTION_KEY` before starting the new API. Do not prune `IdempotencyKey` rows by age. The first enabled job also catches up ended leases and applies previously unallocated credit; review staging balances after upgrading. Keys already deleted by an older release cannot be reconstructed, so reconcile any old uncertain payments before retrying them during an upgrade.

## 5. Backups and restore

With a managed database, enable daily snapshots **and** point-in-time recovery (7+ days).

With the bundled database and local uploads, run the backup script nightly (example cron; configure the server's cron timezone to Manila):

```sh
30 2 * * * /bin/sh /srv/rentflow/deploy/backup.sh /var/backups/rentflow
```

The script passes the production environment file to every Compose command, checks command exit status and gzip integrity, and publishes the database and uploads archives only after both commands succeed. Configure an alert on a nonzero exit and stale backups. Uploaded documents are not in the database; both archives are needed for recovery. Quiesce uploads/deletions while taking a coordinated snapshot if exact point-in-time correspondence is required.

With `STORAGE_DRIVER=s3`, enable versioning (or provider-side backups) on the bucket.

Copy the files to encrypted off-site storage and keep at least 30 days.

**Restore drill (do this quarterly, into a scratch database):**

```sh
createdb -h <host> -U <user> rentflow_restore
gunzip -c rentflow-YYYYMMDDTHHMMSSZ.dump.gz > rentflow_restore.dump
pg_restore -h <host> -U <user> -d rentflow_restore --no-owner --exit-on-error rentflow_restore.dump
```

Then point a staging API at it and confirm the dashboard totals match.

**Repeatable local restore check:** install PostgreSQL client tools matching the embedded test server's major version (currently 18), put `pg_dump` and `pg_restore` on `PATH`, and run:

```sh
npm run test:restore
```

Alternatively set `PG_DUMP_PATH` and `PG_RESTORE_PATH` to the executable paths. `tar` must also be available (`TAR_PATH` can override it). This check creates and removes its own temporary PostgreSQL cluster and uploads directory; it does not use the application's database. It upgrades a populated older schema, confirms readiness rejects pending migrations, backs up the stopped application's database and uploads, restores both into new locations, and checks balances, receipts, private files, sessions, operation retries, receipt numbering, encrypted email recovery and pending file deletion. It also checks that failed backups leave no published or partial archive. Use a separate staging drill with the deployment's PostgreSQL 17 container and real backup locations before production.

For a standalone database backup outside Compose, `npm run db:backup --workspace api` uses the supplied `DATABASE_URL`. It removes Prisma-only connection options before calling `pg_dump`, keeps the password out of process arguments, verifies the custom-format archive with `pg_restore --list`, and publishes it only after successful checks. Set `BACKUP_DIR` to select the destination; the same executable overrides are supported. This command backs up only the database. Preserve uploads and both encryption keys separately.

## 6. Monitoring

- Uptime checks: `/api/v1/health/live` (process) and `/api/v1/health/ready` (database reachable and migrated).
- Alert on HTTP 5xx rate, `JOB_FAILED` / `ORGANIZATION_JOB_FAILED`, `MAIL_DELIVERY_FAILED` / `MAIL_QUEUE_FAILED`, `STORAGE_PUT_FAILED` / `STORAGE_CLEANUP_FAILED` / `STORAGE_CLEANUP_DEFERRED` / `UPLOAD_CLEANUP_DEFERRED` / `STORAGE_OBJECT_MISSING` log events, disk usage, and backup age.
- Include `JOB_RELEASE_FAILED`, `STAFF_ALERT_FAILED` and `OUTBOX_RUN_FAILED` in alerts. Owners/managers can inspect exhausted staff alerts at authenticated `GET /api/v1/notifications/failed`; results are scoped to their workspace.
- Queued email failures are available at `GET /api/v1/notifications/mail/failed` for owners/managers (their workspace plus their own account messages). `POST /api/v1/notifications/mail/:id/retry` retries an unexpired retained message after the provider is repaired. Expired or cancelled links require a new invitation/reset/verification request. Responses never expose email bodies or addresses.
- Every response carries `x-request-id`; 500 errors show the reference to users, and logs contain it alongside stack frames only. Logs never contain request bodies, passwords, tokens, or exception messages.

## 7. Security checklist before going live

- [ ] `.env.production` is readable only by the deploy user and is not in git.
- [ ] Database is not reachable from the internet (the compose file does not publish port 5432).
- [ ] `https://securityheaders.com` reports CSP, HSTS, and frame protection on the site.
- [ ] Password reset email arrives, and the link works once.
- [ ] Backups run (database **and** uploaded documents) and a restore drill has succeeded.
- [ ] If using S3 storage, the bucket blocks all public access.
- [ ] `MFA_ENCRYPTION_KEY` is set and backed up, and owners have turned on two-step sign-in (Account page).
- [ ] A privacy notice for tenants is published (Data Privacy Act of 2012, RA 10173), and a Data Protection Officer is designated if required.
