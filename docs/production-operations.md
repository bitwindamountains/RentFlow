# Production operations

See [deployment.md](deployment.md) for installation, configuration, backups, and monitoring. This page describes how the system behaves in production.

## Safeguards built into the system

- **Fail-closed configuration.** The API will not start without an explicit `NODE_ENV`, a PostgreSQL `DATABASE_URL`, HTTPS origins, and (in production) a real email provider.
- **Authorization on the server.** Every route requires a session and an explicit role list, unless it is marked public. Every record lookup is scoped to the caller's organization. Database triggers additionally reject any row that references another organization's records.
- **Sessions.** httpOnly, `SameSite=Strict`, `__Host-` prefixed cookie; CSRF token on every write. Sessions end after 12 hours, or after 2 hours of inactivity. Password changes and resets revoke other sessions. Suspending or removing a staff member revokes their sessions immediately.
- **Rate limits.** 300 requests/minute per session or IP overall. Stricter per-IP limits apply to sign-in, registration, password reset, email verification, and invitation acceptance.
- **Financial integrity.**
  - Posted charges and payments are never edited or deleted. Corrections use adjustments (discount, waiver, credit note), voids, and reversals, and every one of these writes a ledger entry.
  - Money is `numeric(19,4)` and is validated to two decimals. The web app calculates in integer centavos.
  - Payments, charges, deposits, and guided setup are idempotent. A retry with the same `Idempotency-Key` returns the original result.
  - Rent is unique per lease and month, across manual and automatic billing.
- **Uncertain payments.** An unconfirmed payment is saved in the browser tab's session storage before it is sent. Reopening Record payment in that tab offers a safe retry with the same key. It does not record a second payment.
- **Personal data.** Audit logs record who changed what, but personal fields (names, emails, phones, document URLs) are redacted. Tokens in emailed links travel in the URL fragment and never reach server logs.
- **Uploaded documents.** PDF, JPEG, PNG, and WebP only, identified by their content (a renamed HTML or SVG file is rejected), up to `UPLOAD_MAX_MB` each and `STORAGE_QUOTA_MB` per workspace. Files sit in private storage under server-generated names and are served only through the API after the same workspace and role checks as every other record, with `nosniff` and a sandboxing CSP; PDFs always download rather than render. Removing a document erases the file immediately; the record of who uploaded and removed it stays in the audit log.

## Background jobs

When `ENABLE_JOBS=true` (the default outside tests), the job runs every 15 minutes, holding a database lease so only one instance runs it at a time. For each active organization, in its own time zone, it:

1. Marks leases whose end date has passed as expired and frees the unit.
2. Posts every due, not-yet-posted scheduled charge (catching up missed months).

It also purges expired idempotency keys, used or expired tokens, and old sessions, and marks expired invitations. One organization's failure is logged and does not block the others.

## Rent rules

- **Billing and due days** are 1–28, so every month has them. If the due day is before the billing day, the charge is due the following month.
- **New leases** post the move-in month immediately. Choose full rent, prorated rent (actual days in that month, rounded half-up to centavos), or none. Recurring rent starts on the first of the next month.
- **Rent changes** apply from the first bill on or after the effective date. Already-billed months are never rewritten.
- **Termination** is immediate (today or earlier). Credit unused days with a charge adjustment.
- **Overdue** means due date + the lease's grace days is before today, in the organization's time zone.

## Known limitations

- Uploaded files are not virus-scanned. They are never executed or rendered inside the app, but staff should still only open files from people they know.
- No tenant portal or online payment gateway yet. Payments are recorded by staff.
- Rate-limit counters are per API instance. Use one API instance, or add a shared store before scaling horizontally.
- Receipts are acknowledgement receipts, not BIR official receipts.
