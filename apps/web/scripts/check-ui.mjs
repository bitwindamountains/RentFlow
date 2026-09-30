// Local visual review: deterministic fixtures, no writes to the rental database.
import { chromium } from '../../../node_modules/.cache/rentflow-ui-tools/node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../.ui-review/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const profile = {
  user: { id: 'owner', name: 'Demo Owner', email: 'demo@rentflow.local' },
  organization: { id: 'org', name: 'RentFlow Demo', currency: 'PHP', timezone: 'Asia/Manila' },
  role: 'OWNER',
  csrfToken: 'visual-review',
};
const tenant = {
  id: 'tenant',
  firstName: 'Alexandra',
  lastName: 'Santos',
  email: 'alexandra@example.test',
  phone: '09123456789',
  balance: '6500.00',
};
const unit = {
  id: 'unit',
  number: '201',
  type: 'Studio',
  status: 'OCCUPIED',
  monthlyRent: '6500.00',
};
const lease = {
  id: 'lease',
  tenantId: 'tenant',
  unitId: 'unit',
  status: 'ACTIVE',
  monthlyRent: '6500.00',
  startDate: '2026-09-01',
  billingDay: 1,
  dueDay: 5,
  unit,
  tenant,
};
const charge = {
  id: 'charge',
  leaseId: 'lease',
  description: 'September rent',
  type: 'RENT',
  amount: '6500.00',
  outstanding: '6500.00',
  dueDate: '2026-09-05',
  status: 'POSTED',
};
const fixtures = {
  '/auth/me': profile,
  '/auth/login': profile,
  '/properties': [
    {
      id: 'property',
      name: 'Sunrise Apartments',
      type: 'Apartment',
      address: '12 Mango Avenue',
      city: 'Cebu City',
      units: [unit, { ...unit, id: 'vacant', number: '202', status: 'AVAILABLE' }],
    },
  ],
  '/tenants': [tenant],
  '/leases': [lease],
  '/charges': [charge],
  '/payments': [
    {
      id: 'payment',
      tenantId: 'tenant',
      receiptNumber: 'RF-2026-000001',
      referenceNumber: 'GC-123456',
      method: 'GCASH',
      amount: '6500.00',
      paidAt: '2026-09-01T08:00:00Z',
      status: 'POSTED',
    },
  ],
  '/dashboard': {
    expected: '13000',
    collected: '6500',
    outstanding: '6500',
    activeLeases: 1,
    occupiedUnits: 1,
    totalUnits: 2,
    collectionRate: 50,
  },
  '/reminders': [
    {
      id: 'reminder',
      type: 'overdue',
      title: 'September rent is overdue',
      detail: 'Alexandra Santos · Unit 201 · PHP 6,500',
      route: '/billing',
      severity: 'high',
    },
  ],
  '/reports/financial': {
    collected: '6500',
    outstanding: '6500',
    expenses: '850',
    netCash: '5650',
    paymentCount: 1,
    chargeCount: 2,
    expenseCount: 1,
  },
  '/staff': {
    members: [
      {
        id: 'member',
        user: { displayName: 'Demo Owner', email: 'demo@rentflow.local' },
        role: 'OWNER',
        status: 'ACTIVE',
      },
    ],
    invitations: [],
  },
  '/expenses': [
    {
      id: 'expense',
      description: 'Replace kitchen tap',
      category: 'REPAIR',
      amount: '850.00',
      incurredOn: '2026-09-20',
      property: { name: 'Sunrise Apartments' },
    },
  ],
  '/maintenance': [
    {
      id: 'maintenance',
      title: 'Repair kitchen tap in unit 201',
      priority: 'HIGH',
      status: 'OPEN',
      createdAt: '2026-09-20',
      property: { name: 'Sunrise Apartments' },
    },
  ],
  '/documents': [
    {
      id: 'doc',
      name: 'Signed lease agreement',
      category: 'Lease',
      url: 'https://example.test/lease',
      createdAt: '2026-09-01',
    },
  ],
  '/deposits': [
    {
      id: 'deposit',
      balance: '6500.00',
      lease: { primaryTenant: tenant, rentableSpace: { unit } },
      transactions: [{ type: 'RECEIPT', occurredAt: '2026-09-01' }],
    },
  ],
};
await page.route('**/api/v1/**', (route) => {
  const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
  return route.fulfill({
    json: fixtures[path] ?? [],
    headers: {
      'access-control-allow-origin': 'http://localhost:4200',
      'access-control-allow-credentials': 'true',
    },
  });
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function capture(name) {
  await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', fullPage: !name.startsWith('payment-') && name !== 'mobile-menu' });
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert(
    sizes.scroll <= sizes.width + 1,
    `${name}: page overflow ${sizes.scroll} > ${sizes.width}`,
  );
}
try {
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto('http://localhost:4200/auth');
    await page.getByRole('heading', { name: 'Sign in to RentFlow' }).waitFor();
    assert.equal(
      await page
        .locator('main.auth-page')
        .evaluate((el) => Math.round(el.getBoundingClientRect().left)),
      0,
    );
    await capture(`auth-${width}`);
  }
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await capture('register-320');
  await page.goto('http://localhost:4200/auth');
  await page.route('**/auth/login', (route) =>
    route.fulfill({ status: 401, json: { message: 'Invalid email or password' } }),
  );
  await page.getByLabel('Email address').fill('visual@example.test');
  await page.getByLabel('Password', { exact: true }).fill('invalid-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await capture('auth-error-320');
  await page.unroute('**/auth/login');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of [
      'dashboard',
      'properties',
      'tenants',
      'leases',
      'billing',
      'payments',
      'deposits',
      'expenses',
      'maintenance',
      'documents',
      'reminders',
      'reports',
      'staff',
      'setup',
      'accept-invite',
    ]) {
      await page.goto(`http://localhost:4200/${route}`);
      await page.locator('h1').waitFor({ state: 'attached' });
      await page.getByText('Loading records…', { exact: true }).waitFor({ state: 'hidden' });
      await capture(`${route}-${width}`);
    }
  }
  await page.goto('http://localhost:4200/properties');
  await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await capture('property-form-mobile');
  await page.getByRole('button', { name: /Record payment/ }).click();
  await page.getByRole('dialog').waitFor();
  await capture('payment-mobile');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await capture('payment-details-mobile');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await capture('payment-review-mobile');
  await page.getByRole('button', { name: 'Close payment form' }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('#primary-navigation');
    return panel?.classList.contains('open') && Math.abs(panel.getBoundingClientRect().left) < .5 && getComputedStyle(panel).visibility === 'visible';
  });
  await capture('mobile-menu');
  assert.equal(Math.round((await page.locator('#primary-navigation').boundingBox()).x), 0, 'Open navigation must be visible');
  assert.deepEqual(errors, []);
  console.log(`Visual checks passed; screenshots: ${out}`);
} finally {
  await browser.close();
}
