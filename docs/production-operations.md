# Production operations

See [deployment.md](deployment.md) for installation, configuration, backups, and monitoring. This page describes how the system behaves in production.

## Safeguards built into the system

- **Fail-closed configuration.** The API will not start without an explicit `NODE_ENV`, a PostgreSQL `DATABASE_URL`, HTTPS origins, and (in production) a real email provider.
- **Authorization on the server.** Every route requires a session and an explicit role list, unless it is marked public. Every record lookup is scoped to the caller's organization. Database triggers additionally reject any row that references another organization's records.
- **Sessions.** httpOnly, `SameSite=Strict`, `__Host-` prefixed cookie; CSRF token on every write. Sessions end after 12 hours, or after 2 hours of inactivity. Password changes and resets revoke other sessions. Suspending or removing a staff member revokes their sessions immediately.
- **Two-step sign-in (optional, per person).** Anyone can turn on an authenticator-app code from the Account page.
  - **Sign-in:** after the password, a single-use challenge lasts 5 minutes and allows 5 wrong codes. No session exists until a code is accepted. Each code works once.
  - **Recovery:** 10 one-time recovery codes cover a lost phone. Using one emails the account owner.
  - **Storage:** secrets are encrypted with `MFA_ENCRYPTION_KEY`.
  - **Changes:** turning it off, or replacing recovery codes, needs the password and a code. Turning it on signs out the person's other devices.
- **Rate limits.** 300 requests/minute per session or IP overall. Stricter per-IP limits apply to sign-in, registration, password reset, email verification, and invitation acceptance.
- **Financial integrity.**
  - Posted charges and payments are never edited or deleted. Corrections use adjustments (discount, waiver, credit note), voids, and reversals, and every one of these writes a ledger entry.
  - Money is `numeric(19,4)` and is validated to two decimals. The web app calculates in integer centavos.
  - Payments, charges, deposits, and guided setup are idempotent. A retry with the same `Idempotency-Key` returns the original result.
  - Rent is unique per lease and month, across manual and automatic billing.
- **Uncertain payments.** An unconfirmed payment is saved in the browser tab's session storage before it is sent. Reopening Record payment in that tab offers a safe retry with the same key. It does not record a second payment.
- **Personal data.** Audit logs record who changed what, but personal fields (names, emails, phones, document URLs) are redacted. Tokens in emailed links travel in the URL fragment and never reach server logs.
- **Uploaded documents.** PDF, JPEG, PNG, and WebP only, identified by their content (a renamed HTML or SVG file is rejected), up to `UPLOAD_MAX_MB` each and `STORAGE_QUOTA_MB` per workspace. Files sit in private storage under server-generated names and are served only through the API after the same workspace and role checks as every other record, with `nosniff` and a sandboxing CSP; PDFs always download rather than render. Removing a document erases the file immediately; the record of who uploaded and removed it stays in the audit log.

## Tenant portal

- **Access.** Owners and managers invite a tenant from the tenant's page. The invitation goes to the tenant's email, and the link is also shown once so it can be sent by SMS or Messenger. Tenants use the same sign-in, password reset, and session rules as staff.
- **Isolation.** A portal account is bound to one tenant record by the database, and every portal query is scoped to that tenant. Tenants cannot call any staff endpoint, and staff screens cannot list, promote, or suspend portal accounts. Removing access or archiving the tenant signs them out immediately.
- **Payment reports.** A tenant's "I paid" report posts nothing. Collectors, managers, and owners see the reports and any screenshot on the Payments page. **Confirm** records the payment against the oldest charges and issues the receipt in one transaction, so a double click or retry cannot post twice. **Not received** needs a reason, which the tenant sees. Tenants are emailed either way. Reports older than 90 days are refused, and a tenant can have at most 10 pending.
- **Repairs.** Requests go to the maintenance list against the tenant's own unit, marked as reported by the tenant.
- **Shared documents.** Owners and managers can share a document attached to a tenant or one of their leases, such as a signed lease or house rules. The tenant sees it under Documents in the portal. Other documents cannot be shared, and the database enforces this. Downloads use the same private, sandboxed responses as staff downloads. Stopping sharing takes effect immediately.
- **Staff alerts.** Staff are emailed about new tenant reports. Only active staff with a verified email receive them.
  - A payment report goes to owners, managers, and collectors.
  - A repair request goes to owners, managers, and maintenance staff.
  - The alert is written to `OutboxEvent` in the same transaction as the report, so a retried request never alerts twice.
  - It is sent right after the request. If sending fails, the background job retries with backoff, up to 5 attempts.

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
- No online payment gateway yet. Tenants report payments; staff confirm them.
- Rate-limit counters are per API instance. Use one API instance, or add a shared store before scaling horizontally.
- Receipts are acknowledgement receipts, not BIR official receipts.
