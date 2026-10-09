// Local visual review against the real API and a throwaway database.
//
// Starts an embedded PostgreSQL in a temp folder, applies the migrations, runs
// the built API on :3000 and the web dev server on :4200, seeds a workspace
// (and a tenant portal account) through the public API, then opens every staff
// and portal page at several widths in light and dark. It fails on any page
// error, console error, or horizontal overflow. Nothing touches your own
// database. Screenshots go to apps/web/.ui-review/.
//
// Prerequisites: `npm run build --workspace api`, ports 3000 and 4200 free, and
// Playwright in the local tool cache (see docs/ui-visual-review.md).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const apiDir = join(root, 'apps/api');
const webDir = join(root, 'apps/web');
const out = join(webDir, '.ui-review');
const { chromium } = await import(pathToFileURL(join(root, 'node_modules/.cache/rentflow-ui-tools/node_modules/playwright/index.mjs')).href);
const { default: EmbeddedPostgres } = await import(pathToFileURL(join(apiDir, 'scripts/disposable-postgres.mjs')).href);

const API = 'http://localhost:3000/api/v1';
const WEB = 'http://localhost:4200';
const PASSWORD = 'correct horse battery staple';
const WIDTHS = [1440, 768, 390, 320];
const DARK_WIDTHS = [1440, 390];

const children = [];
let postgres;
let dataDir;

async function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer().once('error', () => resolve(false)).once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function waitFor(url, label, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not start within ${timeoutMs / 1000}s`);
}

function start(command, args, options) {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => (log = (log + chunk).slice(-4000)));
  child.stderr.on('data', (chunk) => (log = (log + chunk).slice(-4000)));
  child.on('exit', (code) => {
    if (code && !child.stopping) console.error(`${args.join(' ')} exited with ${code}\n${log}`);
  });
  children.push(child);
  return child;
}

async function stopAll() {
  for (const child of children.reverse()) {
    child.stopping = true;
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    } else child.kill('SIGTERM');
  }
  if (postgres) await postgres.stop().catch(() => undefined);
  if (dataDir) {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(basename(dataDir).startsWith('rentflow-ui-pg-'));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

async function launchBrowser() {
  const candidates = [process.env['UI_BROWSER'], undefined, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  for (const executablePath of candidates) {
    if (executablePath && !existsSync(executablePath)) continue;
    try {
      return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch {
      // try the next browser
    }
  }
  throw new Error('No browser found. Set UI_BROWSER to a Chromium or Edge executable, or run `npx playwright install chromium` in the tool cache.');
}

// ------------------------------------------------------------------- stack
async function startStack() {
  for (const port of [3000, 4200]) if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Stop your dev servers first.`);
  if (!existsSync(join(apiDir, 'dist/main.js'))) throw new Error('Build the API first: npm run build --workspace api');

  dataDir = await mkdtemp(join(tmpdir(), 'rentflow-ui-pg-'));
  const port = 55_000 + Math.floor(Math.random() * 800);
  postgres = new EmbeddedPostgres({ databaseDir: dataDir, port, user: 'ui', password: 'ui', persistent: true, onLog: () => undefined });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('rentflow');
  const databaseUrl = `postgresql://ui:ui@127.0.0.1:${port}/rentflow`;
  execFileSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });

  start(process.execPath, ['dist/main.js'], {
    cwd: apiDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '3000',
      WEB_ORIGIN: WEB,
      APP_URL: WEB,
      DATABASE_URL: databaseUrl,
      MAIL_PROVIDER: 'log',
      ENABLE_JOBS: 'false',
      TRUST_PROXY: '0',
      LOG_LEVEL: 'error',
      RATE_LIMIT_MULTIPLIER: '100',
      STORAGE_DIR: join(dataDir, 'uploads'),
    },
  });
  start(process.execPath, [join(root, 'node_modules/@angular/cli/bin/ng.js'), 'serve', '--port', '4200'], { cwd: webDir, env: process.env });
  await waitFor(`${API}/auth/me`, 'API');
  await waitFor(WEB, 'web dev server');
}

// -------------------------------------------------------------------- seed
async function seed(request) {
  const stamp = Date.now();
  const ownerEmail = `owner-${stamp}@example.test`;
  const registered = await request.post(`${API}/auth/register`, {
    data: { email: ownerEmail, password: PASSWORD, name: 'Maria Reyes', organizationName: 'Reyes Apartments' },
  });
  assert.equal(registered.status(), 201, await registered.text());
  const csrf = (await registered.json()).csrfToken;
  // New workspaces require owner two-step sign-in; the review covers pages, not that setup.
  const db = postgres.getPgClient('rentflow');
  await db.connect();
  await db.query('UPDATE "Organization" SET "requireOwnerMfa" = false');
  await db.end();
  const call = async (method, path, data, headers = {}) => {
    const response = await request.fetch(`${API}${path}`, { method, data, headers: { 'x-csrf-token': csrf, ...headers } });
    if (!response.ok()) throw new Error(`${method} ${path} ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const monthStart = (offset) => {
    const date = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    return date.toISOString().slice(0, 10);
  };

  const property = await call('POST', '/properties', { name: 'Sunrise Apartments', type: 'Apartment', address: '12 Gorordo Avenue', city: 'Cebu City' });
  const units = [];
  for (const [number, rent] of [['201', '8500.00'], ['202', '9000.00'], ['203', '7800.00']])
    units.push(await call('POST', `/properties/${property.id}/units`, { number, type: 'Studio', monthlyRent: rent }));
  const tenants = [];
  for (const [first, last] of [['Jose', 'Santos'], ['Ana', 'Dela Cruz']])
    tenants.push(await call('POST', '/tenants', { firstName: first, lastName: last, email: `${first.toLowerCase()}-${stamp}@example.test`, phone: '+63 917 555 0101' }));
  const leaseA = await call('POST', '/leases', { unitId: units[0].id, tenantId: tenants[0].id, startDate: monthStart(-2), endDate: `${Number(today.slice(0, 4)) + 1}-03-31`, monthlyRent: '8500.00', billingDay: 1, dueDay: 5, depositRequired: '8500.00' });
  await call('POST', '/leases', { unitId: units[1].id, tenantId: tenants[1].id, startDate: monthStart(-1), monthlyRent: '9000.00', billingDay: 1, dueDay: 5 });
  await call('POST', '/billing/run', {});
  const [oldest] = (await call('GET', `/leases/${leaseA.id}/open-charges`)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  await call('POST', '/payments', {
    tenantId: tenants[0].id, leaseId: leaseA.id, amount: '8500.00', method: 'GCASH', referenceNumber: 'GC-7845120369',
    paidAt: new Date().toISOString(), allocations: [{ chargeId: oldest.id, amount: '8500.00' }],
  }, { 'idempotency-key': `ui-${stamp}` });
  await call('POST', '/expenses', { propertyId: property.id, category: 'REPAIR', description: 'Replace kitchen tap', amount: '850.00', incurredOn: today });
  await call('POST', '/maintenance', { propertyId: property.id, unitId: units[0].id, title: 'Leaking kitchen faucet', description: 'Drips all night.', priority: 'HIGH' });
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x20), Buffer.from('\n%%EOF')]);
  const uploaded = await request.post(`${API}/documents/files?name=Signed%20lease&category=Lease&entityType=Lease&entityId=${leaseA.id}`, {
    data: pdf, headers: { 'x-csrf-token': csrf, 'content-type': 'application/pdf' },
  });
  assert.ok(uploaded.ok(), await uploaded.text());
  await call('PATCH', `/documents/${(await uploaded.json()).id}/sharing`, { shared: true });

  // Portal account for the first tenant.
  const invite = await call('POST', `/tenants/${tenants[0].id}/portal/invite`, {});
  const token = new URLSearchParams(new URL(invite.link).hash.slice(1)).get('token');
  const accepted = await request.post(`${API}/staff/invitations/accept`, { data: { token, name: 'Jose Santos', password: PASSWORD } });
  assert.ok(accepted.ok(), await accepted.text());
  return { ownerEmail, tenantEmail: tenants[0].email, tenantId: tenants[0].id };
}

// ----------------------------------------------------------------- checks
const problems = [];
async function signIn(browser, email) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${WEB}/auth`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'));
  const state = await context.storageState();
  await context.close();
  return state;
}

async function review(browser, storageState, label, routes) {
  for (const colorScheme of ['light', 'dark']) {
    for (const width of colorScheme === 'light' ? WIDTHS : DARK_WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme, storageState, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', (error) => problems.push(`${label} ${width} ${colorScheme}: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error' && !/status of 40[134]/.test(message.text())) problems.push(`${label} ${width} ${colorScheme}: ${message.text()}`);
      });
      for (const route of routes) {
        await page.goto(`${WEB}${route}`);
        await page.locator('h1').first().waitFor({ state: 'attached', timeout: 15_000 });
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const name = `${label}${route.replaceAll('/', '-')}-${width}${colorScheme === 'dark' ? '-dark' : ''}`;
        await page.screenshot({ path: join(out, `${name}.png`), fullPage: true, animations: 'disabled' });
        const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        if (sizes.scroll > sizes.width + 1) problems.push(`${name}: horizontal overflow ${sizes.scroll - sizes.width}px`);
        // Amounts must read as one figure: on one line and inside their card.
        const broken = await page.$$eval('.tile-value', (values) =>
          values
            .filter((el) => {
              const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
              return el.getBoundingClientRect().height > lineHeight * 1.5 || el.scrollWidth > el.clientWidth + 1;
            })
            .map((el) => el.textContent.trim()),
        );
        if (broken.length) problems.push(`${name}: amount wraps or overflows (${broken.join(', ')})`);
      }
      await context.close();
      console.log(`Checked ${label}: ${routes.length} routes at ${width}px in ${colorScheme} mode.`);
    }
  }
}

try {
  await mkdir(out, { recursive: true });
  console.log('Starting PostgreSQL, API, and web…');
  await startStack();
  const browser = await launchBrowser();
  try {
    const seedContext = await browser.newContext();
    const seeded = await seed(seedContext.request);
    await seedContext.close();

    // Signed-out pages.
    await review(browser, undefined, 'public', ['/auth']);
    const staff = await signIn(browser, seeded.ownerEmail);
    await review(browser, staff, 'staff', [
      '/dashboard', '/properties', '/tenants', `/tenants/${seeded.tenantId}`, '/leases', '/billing', '/payments', '/deposits',
      '/expenses', '/maintenance', '/documents', '/reminders', '/reports', '/staff', '/account', '/setup',
    ]);
    const tenant = await signIn(browser, seeded.tenantEmail);
    await review(browser, tenant, 'portal', ['/portal', '/portal/payments', '/portal/repairs', '/portal/documents', '/account']);
  } finally {
    await browser.close();
  }
  assert.deepEqual([...new Set(problems)], [], 'Visual review found problems');
  console.log(`Visual checks passed; screenshots: ${out}`);
} finally {
  await stopAll();
}
