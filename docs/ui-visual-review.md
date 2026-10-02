# UI visual review — 2026-09-24

Implemented shared visual corrections across authentication, invitations, dashboard, rental records, operations, setup and payment dialogs.

- Scoped the workspace's sidebar offset to its own main element. Public authentication pages now start at the left edge without a blank sidebar-sized margin.
- Standardized form fonts, control sizes, readable labels, table typography, card spacing, focus outlines and error colors.
- Switched tablet navigation to the compact layout; made the navigation list scroll independently while keeping the account controls visible. Closed mobile navigation no longer leaks its shadow or accepts focus.
- Replaced letter navigation markers with SVG icons, restored the mobile payment action, and improved property-card sizing.
- Kept dates and amounts intact in horizontally scrollable tables. Payment dialogs scroll within the viewport, including small screens.
- Auth defaults to sign-in with empty fields; removed embedded sample credentials and added distinct connection/credential errors. Form validation controls submission.

## Verification

Used headless Microsoft Edge with deterministic API fixtures; no rental database writes were performed. Checked 15 routes at 1440, 768, 390 and 320 pixel widths, plus auth at 1024 pixels, registration, credential errors, mobile navigation, a property form and all three payment steps. All page-width assertions passed; screenshots were captured and representative layouts visually inspected. No browser JavaScript errors occurred.

Production web build and all six web tests pass. Initial bundle: 459.94 kB raw / 113.43 kB estimated transfer. No production dependency was added. This validates rendering with sample data, not live API connectivity, real device performance, or a complete accessibility audit.

Screenshots are generated in `apps/web/.ui-review/` (ignored by Git). Useful previews: `auth-1440.png`, `dashboard-1440.png`, `properties-768.png`, `billing-390.png`, `payment-review-mobile.png`.

## Repeating the review

`apps/web/scripts/check-ui.mjs` runs against the real API on a throwaway database. Since 2026-10-02 it no longer uses fixtures.

What it does:
1. Starts an embedded PostgreSQL in a temp folder and applies the migrations.
2. Runs the built API on :3000 and the web dev server on :4200.
3. Seeds a workspace through the API: properties, leases, a payment, an expense, a repair, a shared lease document, and a tenant portal account.
4. Opens every staff page and every portal page:
   - in light mode at 1440, 768, 390 and 320 pixels;
   - in dark mode at 1440 and 390 pixels.

It fails on any of these:
- a browser error or console error;
- horizontal page overflow;
- a dashboard amount that wraps or overflows its card.

Everything it started is stopped afterwards, and your own database is never touched.

One-time setup (Playwright in a local cache, not a project dependency):

```powershell
npm.cmd install --prefix node_modules/.cache/rentflow-ui-tools --no-save --package-lock=false playwright
```

Each run, with ports 3000 and 4200 free, from the project root:

```powershell
npm.cmd run build --workspace api
node apps/web/scripts/check-ui.mjs
```

It uses Playwright's Chromium if it is installed, otherwise Microsoft Edge. Set `UI_BROWSER` to use another Chromium-based browser. Screenshots go to `apps/web/.ui-review/`, which Git ignores. A run takes about 3 minutes.
