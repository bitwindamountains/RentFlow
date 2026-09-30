# UI and workflow review

Reviewed 2026-09-24. This is a source review and targeted implementation, not a production-readiness certification or device-performance audit.

## Follow-up implementation (2026-09-24)

Subsequent rendering checks and visual corrections are documented in [UI visual review](ui-visual-review.md). Its browser verification supersedes the earlier statement that rendering had not been measured; operational limitations below still apply.

The findings below are the original review. The following gaps have now been addressed:

- Guided setup uses an atomic PostgreSQL transaction with a persisted idempotency response. Validation failure leaves no partial rental; same-key replay returns the original result. Blank optional email is omitted. Misleading “Save for later” copy is removed.
- Property, unit, tenant, lease, and one-off charge creation have focused forms. Leases select existing available units and tenants. Property and tenant editing is tenant-scoped and audited. Property cards expand to show units.
- Resource pages use real organization names, active lease rents, outstanding charges, actual rental associations, posted-only collections and status counts. Unsupported filters and fictional dates/metrics were removed; text search works.
- Payment lease selection supports multi-unit tenants. Uncertain retries reuse the exact payload/key while the app remains open; duplicate submissions are blocked. Payment modal focus wraps/restores, and payment changes refresh visible payments/dashboard data.
- Reversal, extension and move-out use validated confirmation forms. Extensions retain the same rent; differing rent is explicitly rejected rather than silently rewriting an existing billing schedule.
- Deposits require an idempotency key and use serializable transactions; the UI preserves uncertain requests for retry. Zero amounts are rejected consistently.
- Sessions recheck live membership role/status, disabled users and organization status on every request. Maintenance users cannot read financial or document routes; property lookups for them contain only ID/name. UI routing and primary actions reflect role restrictions. API 401s on record reads/writes return the user to sign-in.
- Billing respects billing day, derives the current date from organization timezone, and catches up missed months on active schedules. CSV cells with formula prefixes are escaped.

Still outstanding before a full production-readiness claim: password recovery/email verification and delivery configuration; staff revocation controls; pending-request recovery across full page reloads; comprehensive unsaved-draft protection; unit editing; server pagination and report date filters; future-effective lease changes/scheduled move-out; full keyboard/screen-reader/device/PWA testing; verified backup restoration and deployment monitoring. Linked documents still depend on the external storage provider's access controls. Setup/edit endpoints require PostgreSQL, not the development in-memory store.

No new UI dependency or database migration was introduced. Test accounts/records were created only in the local development database.

Follow-up verification: API and production web builds pass; 14 API end-to-end tests (including PostgreSQL), 4 API unit tests, and 6 web tests pass. The web initial bundle is approximately 449.04 kB raw / 111.02 kB estimated transfer. Browser/device performance and visual rendering were not measured in this pass.

## Implemented

- Grouped navigation into Workspace, Money, and Operations; mobile More now opens the complete menu.
- Replaced the inert global search with a working page finder, including Enter navigation and Escape dismissal. It deliberately does not claim to search tenant or receipt records.
- Removed fictional subscription usage and organization-switching affordances; reminders now has a working link.
- Added skip navigation, current-page announcements, visible keyboard focus, larger primary controls, scrollable navigation, mobile safe-area support, and readable form inputs.
- Added short, one-shot surface entry and button-press effects using opacity/transform. No animation dependency, polling, perpetual animation, or layout-property animation was added. Reduced-motion users receive no transitions or animations.
- Payment errors are visible throughout the wizard; invalid amounts cannot advance; allocations are sorted by due date to match the oldest-first promise.

## Important remaining workflow work

| Priority | Finding | Required outcome |
| --- | --- | --- |
| Launch blocker | Setup creates property, unit, tenant, lease, and charge in separate requests (`setup.page.ts`). A failure can leave partial records; retry starts again. | Atomic server operation or persisted resumable steps, with duplicate prevention. Omit blank optional email values. |
| Launch blocker | Resource screens still include fictional or misleading information (`resource.page.html`): fixed organization name, rent estimated as units × 6500, fixed due dates, placeholder rental details and inactive controls. | Bind every displayed value to authoritative data; remove unsupported controls and show explicit unavailable/empty states. |
| Launch blocker | Payment wizard selects the first active lease and generates a new request key on each posting attempt (`app.ts`). | Explicit lease choice for multi-unit tenants; preserve an idempotency key and payload through uncertain-response retries. Show allocation preview and resulting balance. |
| High | Property/tenant/lease create actions all lead to full setup (`resource.page.ts`). | Separate minimal create/edit/detail flows; select existing records instead of forcing duplicate setup. |
| High | Renewal, move-out, and reversal use browser prompts (`resource.page.ts`). | Validated forms with dates, reason, financial consequences, confirmation, and pending-state protection. |
| High | Modal/menu accessibility needs further work. | Focus containment/restoration, background inertness, keyboard and screen-reader checks, and focus movement after route changes. |
| High | Search/filter controls and summary metrics remain inconsistent across resource screens. | Working filters, posted-only collection totals, accurate status counts, pagination and links from summaries to filtered records. |
| High | Authentication and permissions require a dedicated verification pass. | Verify account recovery, session expiry handling, disabled-membership revocation, and least-privilege read/write access with API tests for each role. UI hiding alone is not authorization. |
| High | Billing and financial concurrency need production verification. | Test billing-day/time-zone boundaries, concurrent occupancy/deposit mutations, effective-dated renewals, reversal retries, and CSV export safety. |
| Medium | PWA and operational readiness are not proven by a web build. | Test installation/update on actual devices, expired sessions while offline, restore from backup, and deployment monitoring. Keep private API data out of shared offline caches. |

## Recommended delivery order

1. Trustworthy live data and safe, retryable setup/payment flows.
2. Focused property → unit → tenant → lease workflows and validated move-out/reversal forms.
3. Role/session/billing/concurrency tests, followed by mobile accessibility and PWA device checks.

Avoid expanding scope into decorative dashboards, complex motion libraries, offline financial writes, or advanced customization until these basics are reliable.

## Verification and design basis

Production web build passes: 433.05 kB raw initial bundle, 109.05 kB estimated transfer. Compared with the earlier approximately 427.6 kB / 107.9 kB build, this is a small increase, not a measured runtime speed guarantee. No new dependency was installed.

Motion follows [web.dev's animation guidance](https://web.dev/articles/animations-guide) and [reduced-motion guidance](https://web.dev/articles/prefers-reduced-motion). Focus and target improvements draw on [WCAG focus appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance) and [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum); full accessibility conformance has not been audited.
