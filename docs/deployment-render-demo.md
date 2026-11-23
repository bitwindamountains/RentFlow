# Public demo on Render (free)

A public "Try the demo" site for showing RentFlow to prospects. It is not a place for real landlords or tenants. `render.demo.yaml` describes three free Render resources, all in Singapore:

| Resource | Name | What it is |
| --- | --- | --- |
| PostgreSQL 17 | `rentflow-demo-db` | Throwaway demo data. Render deletes free databases 30 days after creation. |
| Web service (Node) | `rentflow-demo-api` | The API, with `DEMO_ENABLED=true`. Runs migrations at start. |
| Static site | `rentflow-demo` | The PWA. It rewrites `/api/*` to the API, so the browser sees one origin and the session cookie and CSRF work unchanged. |

No code changes are needed: demo mode already exists (see "Demo mode" in `production-operations.md`).

## Deploy

TindaBot's Blueprint flow asked for a card, and the card was declined. If that happens here too, create the three resources by hand in the dashboard with the values from `render.demo.yaml`, in this order:

1. **New → PostgreSQL**: name `rentflow-demo-db`, region Singapore, PostgreSQL 17, plan Free. Copy its **Internal Database URL**.
2. **New → Web Service** from this repo: name `rentflow-demo-api`, runtime Node, region Singapore, plan Free. Use the build command, start command, health check path and environment variables from the file. Set `DATABASE_URL` to the internal URL.
3. **New → Static Site** from this repo: name `rentflow-demo`. Use the build command and publish directory from the file. Under **Redirects/Rewrites**, add, in this order:
   - `/api/*` rewrites to `https://rentflow-demo-api.onrender.com/api/*`
   - `/*` rewrites to `/index.html`

   Under **Headers**, add the headers from the file.
4. If Render gives different `.onrender.com` names, update `WEB_ORIGIN` and `APP_URL` on the API, and the rewrite destination on the static site.
5. **Check** (the API sleeps after about 15 minutes idle, so the first request can take about a minute):
   - `https://rentflow-demo-api.onrender.com/api/v1/health/ready` answers ready.
   - On `https://rentflow-demo-x6iq.onrender.com`, **Try the demo** opens a seeded "Demo Rentals" workspace, and a payment can be recorded.
   - Reload a deep link such as `/dashboard`: it loads the app, not a 404.
   - **Client IP:** in the API logs, create two demos from two different networks (Wi-Fi and mobile data). If the 4th demo within an hour from *one* network is refused (`429`) but other networks still work, `TRUST_PROXY=2` is right. If every visitor shares one limit, the API is seeing a Render proxy address; raise or lower `TRUST_PROXY` and check again.

## Limits and caveats

- **Development mode.** `NODE_ENV=development`, because production refuses log-only mail and requires encryption keys and a privacy contact. In development:
  - emails, including sign-up and password-reset links, are only written to the Render logs;
  - two-step sign-in uses a fixed development key;
  - Swagger is public at `/api/docs`;
  - the API sends no HSTS or CSP of its own.
- **Registration stays open.** Anyone can create a normal (non-demo) account. It is never deleted by the demo job and is lost when the database expires. Don't send real landlords here.
- **Static site headers:** there is no Content-Security-Policy on the PWA. A `/*` header rule might also replace the API's own policy on proxied responses, including the sandbox CSP on documents. Document uploads are blocked in demos anyway.
- **Speed:** each API call goes through the static site's rewrite, which Render users report adds a few hundred milliseconds.
- **Jobs** run inside the API process only while it is awake. Expired demos stop working at once regardless; their rows are deleted on the next job run after the API wakes up.
- **After 30 days**, create a new free database, point `DATABASE_URL` at it and redeploy. Migrations run at start.
