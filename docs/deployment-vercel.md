# Deploying to Vercel (free Hobby plan)

One Vercel project serves the PWA from Vercel's CDN and the whole API as one Vercel Function in Seoul (`icn1`), next to the Supabase database. The web app and the API share one origin, so cookies, CSRF and the security headers work as they do behind Caddy. The Docker setup in [deployment.md](deployment.md) still works; this is an alternative.

**Before you choose it:**
- **Non-commercial use only.** Vercel's Hobby plan is for personal, non-commercial use. Once RentFlow earns money, move to Vercel Pro or the Docker setup.
- **Uploads are capped at 4 MB.** Vercel refuses request bodies over 4.5 MB, so `UPLOAD_MAX_MB` defaults to 4 everywhere and the web app checks the same limit.
- **Jobs run on Vercel Cron**, not a timer: `vercel.json` calls `GET /api/v1/jobs/run` every 15 minutes with `Authorization: Bearer $CRON_SECRET`. Vercel's docs disagree on whether Hobby allows every 15 minutes or only once a day. If a deploy fails on the cron schedule, change it to `0 * * * *` or `0 0 * * *`. Emails are still sent right after each request (through `waitUntil`); the cron run only retries failures.
- **Rate limits are per instance.** Sign-in backoff is stored in the database, so it holds across instances. The general request limits are in memory and apply per warm instance.
- **Cold starts:** the first request after an idle spell starts Nest and connects to the database (a few seconds).

## How it fits together

| Piece | File |
|---|---|
| Build, routing, headers, cron, region | [`vercel.json`](../vercel.json) |
| Function entry | [`api/index.mjs`](../api/index.mjs), which re-exports `apps/api/dist/vercel.js` |
| Handler (one Nest app per warm instance; sends queued mail after the response) | [`apps/api/src/vercel.ts`](../apps/api/src/vercel.ts) |
| Cron endpoint | [`apps/api/src/jobs/jobs.controller.ts`](../apps/api/src/jobs/jobs.controller.ts) |

`vercel.json` rewrites `/api/*` to the function (with the original path in `__path`, which the handler restores), and sends paths without a file extension to `index.html`. The web security headers apply to everything except `/api`, so the API's own headers, including the sandboxed CSP on documents, pass through unchanged.

## One-time setup

1. **Accounts (all free, no card):**
   - Vercel, signed up with GitHub.
   - A Gmail account for sending mail, with two-step verification on and an app password.
   - In Supabase, a private Storage bucket (for example `rentflow-documents`) and an S3 access key (Project Settings > Storage).
2. **Supabase CA:** download it (Database settings > SSL Configuration) and commit it as `deploy/certs/prod-ca-2021.crt`. It is a public certificate. `vercel.json` bundles that folder with the function.
3. **Migrations:** Vercel does not run them. Before each deploy that adds a migration, run `npm run db:deploy --workspace api` from your machine against the **session** pooler (port 5432). The transaction pooler cannot run migrations. Readiness (`/api/v1/health/ready`) fails until every shipped migration is applied.
4. **Import the repository** at vercel.com/new. Keep the Root Directory as the repository root; `vercel.json` sets the build. Set Node.js to 24.x.
5. **Environment variables** (Project Settings > Environment Variables, Production):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `WEB_ORIGIN` | `https://<project>.vercel.app` (and `APP_URL` is taken from it) |
| `DATABASE_URL` | The Supabase **transaction** pooler, with one connection pool per instance: `postgresql://rentflow.<ref>:<password>@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?schema=rentflow&pgbouncer=true&connection_limit=3&sslmode=require&sslaccept=strict&sslcert=/var/task/deploy/certs/prod-ca-2021.crt` |
| `ENABLE_JOBS` | `false` (Vercel Cron runs them) |
| `CRON_SECRET` | At least 32 random characters (`openssl rand -hex 32`); Vercel sends it to the cron endpoint |
| `TRUST_PROXY` | `1` (Vercel sets `x-forwarded-for` to the client and drops spoofed values) |
| `MAIL_PROVIDER` / `SMTP_URL` / `MAIL_FROM` | `smtp` / `smtps://<you>%40gmail.com:<app-password>@smtp.gmail.com:465` / `RentFlow <you@gmail.com>` (Gmail only sends as your own address, roughly 500 messages a day) |
| `MAIL_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY` | `openssl rand -base64 32` each; keep copies with your backups |
| `PRIVACY_CONTACT_EMAIL` | The contact shown on `/privacy` |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` | your bucket / `ap-northeast-2` / `https://<ref>.storage.supabase.co/storage/v1/s3` / `true` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | the Supabase S3 key pair |
| `DEMO_ENABLED` | `false` to start. Demo creation is serialized only within one instance. |

**Connections:** each warm instance opens up to `connection_limit` connections to the transaction pooler, which shares a small pool of real connections (the `rentflow` role is capped at 10). Transactions wait up to 10 seconds for a free connection instead of failing.

## After each deploy

- `curl https://<project>.vercel.app/api/v1/health/ready` returns `"status":"ready"`.
- Sign up, verify your email, turn on two-step sign-in, upload a document, and reset your password.
- In Vercel > Cron Jobs, the job shows a successful run, and the function log has no `JOB_FAILED`.

## Backups

Supabase's free tier has no backups. Schedule `npm run db:backup --workspace api` on a machine with `pg_dump` 17 or later (see [deployment.md](deployment.md#5-backups-and-restore)). With `STORAGE_DRIVER=s3`, documents live in Supabase Storage, which also has no backups on the free tier; copy the bucket periodically (any S3 tool works with the S3 key).

## Not yet verified on a real deployment

- Where Vercel puts bundled files: the `sslcert` path assumes `/var/task/deploy/certs/`. If the API fails with a TLS or certificate error, check the path in the function log.
- Whether Hobby accepts the 15-minute cron schedule.
- That Vercel passes the original `/api/...` path or the `__path` form. The handler accepts both.
