# RentFlow Web

Angular 22 PWA (standalone components, signals, lazy routes, service worker). See the [root README](../../README.md) for setup.

- `src/app/pages`: one file per screen, for staff (dashboard, billing, payments, reports and more) and the tenant portal (`portal-*`)
- `src/app/core`: API client, route guard, and money and date formatting

```sh
npm start        # http://localhost:4200, expects the API on http://localhost:3000
npm run build
npm test
```

Run them from `apps/web`, or from the repo root with `--workspace web`.
