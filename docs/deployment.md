# Deploying RentFlow

RentFlow ships as three containers built from the root `Dockerfile`:

| Target | Role |
| --- | --- |
| `web` | Caddy: automatic HTTPS, serves the PWA, proxies `/api/*` to the API, sets CSP/HSTS and cache headers |
| `api` | NestJS API (non-root, production dependencies only) |
| `migrate` | Runs `prisma migrate deploy` once per release, before the API starts |

PostgreSQL 17 is required. A managed database with point-in-time recovery (e.g. DigitalOcean, AWS RDS, Supabase Postgres, Neon) is strongly recommended over the bundled container.

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
- a non-HTTPS `WEB_ORIGIN`;
- `MAIL_PROVIDER=log` in production.

| Variable | Notes |
| --- | --- |
| `WEB_ORIGIN` | Exact public origin(s), comma-separated, `https://` only |
| `APP_URL` | Base for links in emails (defaults to the first `WEB_ORIGIN`) |
| `DATABASE_URL` | Add `connection_limit=10` (or your pooler's limit) |
| `TRUST_PROXY` | Number of reverse proxies in front of the API (`1` with the bundled Caddy). Rate limiting keys on the client IP this reveals. |
| `ENABLE_JOBS` | Billing, lease expiry, and cleanup every 15 minutes. Safe on every instance (a database lease ensures one runner). |
| `SESSION_ABSOLUTE_HOURS` / `SESSION_IDLE_MINUTES` | Default 12 h absolute, 120 min idle |
| `STORAGE_DRIVER` | `local` (default: the `uploads` volume at `STORAGE_DIR=/data/uploads`) or `s3` (any S3-compatible bucket; see the example env file). The bucket must be **private**; files are only served through the API. |
| `UPLOAD_MAX_MB` / `STORAGE_QUOTA_MB` | Per-file limit (default 10 MB) and per-workspace total (default 2 GB) |
| `MFA_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). It encrypts authenticator-app secrets for two-step sign-in. Without it, people cannot turn on two-step sign-in. Keep a copy with your backups: if it is lost, accounts with two-step sign-in can only sign in with recovery codes until an admin clears `mfaSecret`. |

## 3. Launch

```sh
docker compose -f compose.prod.yaml --env-file .env.production up -d --build
docker compose -f compose.prod.yaml logs -f api
```

Check `https://<your-domain>/api/v1/health/ready` → `{"status":"ready"}`, then open the site and register the owner account.

## 4. Releasing an update

```sh
git pull
docker compose -f compose.prod.yaml --env-file .env.production up -d --build
```

`migrate` runs before `api` starts. Migrations are forward-only; take a backup first (below). Installed PWAs detect the new version and offer **Reload now**.

## 5. Backups and restore

With a managed database, enable daily snapshots **and** point-in-time recovery (7+ days).

With the bundled container, schedule a nightly dump off the server (example cron, 02:30 Manila time):

```sh
30 2 * * * cd /srv/rentflow && docker compose -f compose.prod.yaml exec -T postgres \
  pg_dump -U rentflow -d rentflow --format=custom | gzip > /var/backups/rentflow-$(date +\%F).dump.gz
```

Uploaded documents are not in the database. With `STORAGE_DRIVER=local`, back up the `uploads` volume as well (same schedule):

```sh
45 2 * * * cd /srv/rentflow && docker compose -f compose.prod.yaml run --rm --no-deps -T --entrypoint tar api \
  -C /data -czf - uploads > /var/backups/rentflow-uploads-$(date +\%F).tar.gz
```

With `STORAGE_DRIVER=s3`, enable versioning (or provider-side backups) on the bucket.

Copy the files to encrypted off-site storage and keep at least 30 days.

**Restore drill (do this quarterly, into a scratch database):**

```sh
createdb -h <host> -U <user> rentflow_restore
gunzip -c rentflow-YYYY-MM-DD.dump.gz | pg_restore -h <host> -U <user> -d rentflow_restore --no-owner
```

Then point a staging API at it and confirm the dashboard totals match.

## 6. Monitoring

- Uptime checks: `/api/v1/health/live` (process) and `/api/v1/health/ready` (database reachable and migrated).
- Alert on HTTP 5xx rate, `JOB_FAILED` / `ORGANIZATION_JOB_FAILED`, `MAIL_DELIVERY_FAILED`, `STORAGE_PUT_FAILED` / `STORAGE_DELETE_FAILED` / `STORAGE_OBJECT_MISSING` log events, disk usage, and backup age.
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
