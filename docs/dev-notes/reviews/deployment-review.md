# RentFlow deployment review — fixes completed

The ten priority findings from the review have been addressed. Local builds, automated checks, production-mode API checks and a database-and-files restore drill pass. Local testing is the current scope; container and browser acceptance remain before production sign-off.

## Resolved findings

| Finding | Change | Regression evidence |
| --- | --- | --- |
| Login limit bypass through invalid cookies | Default and route-specific limits use the normalized client IP, independent of unverified cookies. | Rotating invalid cookies reaches HTTP 429. |
| Morning tenant payment confirmations | Date-only reports use the first instant of the reported day in the organization's timezone. The conversion is deterministic across retries. | Original portal tests pass; midnight, morning, year-end and DST date tests pass. |
| Rent missed across lease expiry | Billing runs before expiry and also recovers due periods on ended leases, bounded by schedule and lease end dates. Schedule eligibility and amounts are re-read inside each posting transaction. | Outage/expiry and already-terminated lease catch-up tests pass. |
| Unapplied advance payments | Posted credit is allocated oldest-first when payments or charges are posted. Allocation changes are audited without recording cash twice; reversals restore debt. The job reconciles existing credit. | Prepayment, reversal, balance reconciliation and concurrent-charge tests pass. |
| Duplicate payments after delayed retries | Operation keys and responses are retained indefinitely. Each serializable retry checks the key before revalidating balances. | Expired legacy keys survive cleanup; delayed and simultaneous retries return the original payment. |
| Clean-checkout CI schema failure | CI supplies DATABASE_URL to Prisma as well as TEST_DATABASE_URL to the integration suite. | Schema validation succeeds from the repository root without the ignored API .env. |
| Collection unavailable after move-out | Ended leases with outstanding balances appear in the payment picker with their status. Fully settled ended leases disappear. | Expired-lease settlement test passes. |
| Unhandled scheduler failures | Acquisition, work and release are contained; shutdown completes after failures. The process prevents overlapping runs and renews its database lease. | Acquisition failure, release failure, overlap and shutdown tests pass. |
| Partial staff email delivery lost | Successful recipients are persisted, retries target remaining recipients, and exhausted alerts are visible to managers at GET /api/v1/notifications/failed. | Partial-delivery retry and workspace/role isolation tests pass. |
| Backup commands can fail silently | A backup script consistently supplies the production env file, propagates failures, validates archives and publishes files after successful commands. | Success, failed database dump and failed uploads backup tests pass. |

## Additional deployment improvements

- Readiness checks every migration shipped with the API. The container healthcheck uses readiness.
- CI now builds all Docker targets, validates bundled/managed Compose configurations, starts the stack, checks the proxy and PWA assets, and exercises the backup script.
- compose.managed.yaml removes the bundled database dependency for managed PostgreSQL.
- Disposable PostgreSQL teardown now retries Windows file cleanup after stopping the process.
- Deployment and operations documentation describe the revised billing, credit, retry, monitoring and backup behavior.
- Upload quota is reserved transactionally before storage writes. Failed deletion work and abandoned uploads survive restarts, including local partial-file cleanup. Physical storage is counted until deletion succeeds.
- Verification, password reset, invitations, MFA notices, and tenant payment updates use an encrypted transactional mail queue. Retries survive restarts, skip invalid links, and expose scoped failure/retry endpoints.
- Documents, maintenance, tenant histories and staff payment reports have pagination and Load more controls. Database indexes support the new page queries.
- Production email links require an HTTPS origin. Origins reject embedded credentials and fragments; absolute storage paths work on Windows and Linux.
- The standalone database backup strips Prisma-only connection options, keeps passwords out of process arguments, validates the archive before publishing and removes failed partial files.
- `npm run test:restore` checks an upgrade from a populated legacy schema and a complete database/uploads restore into a disposable local cluster.
- The disposable database harness preserves failing process exit codes; the dependency's automatic success-exit hook is disabled while explicit teardown and signal cleanup remain.

## Final local verification

| Check | Result |
| --- | --- |
| API lint and TypeScript checking | Passed |
| Prisma schema validation | Passed, including without the local API .env |
| API unit tests | 59 passed |
| Web unit tests | 17 passed, including pagination retry and stale-response handling |
| API integration tests | 97 passed, including 4 production-mode tests using a local SMTP receiver |
| Backup script tests | 3 passed |
| Test harness exit status | 2 passed; an intentionally failing integration probe also returned status 1 and was removed |
| Upgrade and restore drill | Passed: legacy data migration/readiness gate, database/files recovery, restored queue processing and backup failure cleanup |
| API/web production builds | Passed |
| Shell and YAML syntax | Passed |
| Whitespace/diff checks | Passed |
| Dependency audit from the review | 0 known production vulnerabilities; dependency manifests were not changed |

The tests use disposable databases, mock providers and a loopback-only SMTP receiver. Production-mode tests cover secure cookie flags, CSRF, CORS, security headers, private downloads, one-time verification/reset links, temporary SMTP failure and retry. They use HTTP injection and do not exercise a browser or TLS termination. No application database was migrated and no external email was sent. Web builds/tests, PostgreSQL tests and Git Bash backup tests required running outside the Windows filesystem sandbox.

The restore drill used the embedded PostgreSQL 18.4 server with PostgreSQL 18.6 client tools. It preserved financial totals, receipts, private files, sessions, operation retry responses and receipt numbering. Queued email decrypted using the preserved key and pending file cleanup resumed. Production's PostgreSQL 17 container still needs the separate container/restore check.

## Upgrade requirements

Apply all four review migrations through `20261009120000_history_pagination` before starting the new API. The supplied Compose flow runs migrations first. Set the new required production `MAIL_ENCRYPTION_KEY` to 32 random bytes encoded as base64 and preserve it with secure backups. Migrations make operation keys permanent, add staff-alert delivery progress, backfill recorded storage objects, create the mail queue, and index history pages. Do not prune IdempotencyKey records by age.

The first enabled job catches up ended leases and applies existing credit. Verify the resulting balances in staging before upgrading real data. Operation keys already deleted by older releases cannot be reconstructed: reconcile any pre-upgrade uncertain payments before retrying them.

Successful staff-alert deliveries are stored durably. Resend also receives a stable recipient/event idempotency key, subject to its [24-hour provider window](https://resend.com/docs/dashboard/emails/idempotency-keys). Generic SMTP cannot guarantee exactly-once delivery across a crash between server acceptance and the database acknowledgment.

## Remaining release checks and backlog

Docker is unavailable on this machine, so the newly added container CI job has not been executed here. YAML validation is not a substitute for running Docker Compose. The browser execution tool is also unavailable, so mobile, keyboard, PWA install/update and real-browser cookie/CSRF flows still require staging acceptance.

Before production, run the container CI job and staging smoke script, verify production-domain mail delivery and private storage access, and repeat the restore drill with the deployment's database version and backup locations. Confirm browser MFA setup/recovery, HTTPS, uptime alerts and backup-age alerts. Local SMTP transport success does not verify external delivery or production DNS.

The requested follow-up is limited to local testing. Pagination, durable email, and upload reservation/recovery are now implemented and covered by regressions. Real-browser acceptance remains outstanding. Legacy files that were already orphaned before storage reservations were introduced still require a storage inventory before deletion.
