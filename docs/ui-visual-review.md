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

To repeat on Windows with Microsoft Edge installed:

```powershell
npm.cmd install --prefix node_modules/.cache/rentflow-ui-tools --no-save --package-lock=false playwright
npm.cmd run dev:web
```

In another terminal at the project root:

```powershell
node apps/web/scripts/check-ui.mjs
```
