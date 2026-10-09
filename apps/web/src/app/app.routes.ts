import type { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import type { Role } from './core/models';
import { AuthPage } from './pages/auth.page';
import { DashboardPage } from './pages/dashboard.page';

const FINANCE: Role[] = ['OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER'];
const MANAGERS: Role[] = ['OWNER', 'MANAGER'];
const ALL: Role[] = [...FINANCE, 'MAINTENANCE'];
const TENANT: Role[] = ['TENANT'];

const page = (path: string, title: string, roles: Role[], load: () => Promise<unknown>) => ({
  path,
  title: `${title} · RentFlow`,
  canActivate: [authGuard],
  data: { roles },
  loadComponent: load as never,
});

export const routes: Routes = [
  { path: 'auth', component: AuthPage, title: 'Sign in · RentFlow' },
  {
    path: 'accept-invite',
    title: 'Accept invitation · RentFlow',
    loadComponent: () => import('./pages/invite.page').then((m) => m.InvitePage),
  },
  {
    path: 'privacy',
    title: 'Privacy notice · RentFlow',
    loadComponent: () => import('./pages/privacy.page').then((m) => m.PrivacyPage),
  },
  {
    path: 'reset-password',
    title: 'Reset password · RentFlow',
    loadComponent: () => import('./pages/token.page').then((m) => m.ResetPasswordPage),
  },
  {
    path: 'verify-email',
    title: 'Verify email · RentFlow',
    loadComponent: () => import('./pages/token.page').then((m) => m.VerifyEmailPage),
  },
  { path: 'dashboard', component: DashboardPage, title: 'Dashboard · RentFlow', canActivate: [authGuard], data: { roles: FINANCE } },
  page('setup', 'Guided setup', MANAGERS, () => import('./pages/setup.page').then((m) => m.SetupPage)),
  page('properties', 'Properties', FINANCE, () => import('./pages/properties.page').then((m) => m.PropertiesPage)),
  page('tenants', 'Tenants', FINANCE, () => import('./pages/tenants.page').then((m) => m.TenantsPage)),
  page('tenants/:id', 'Tenant', FINANCE, () => import('./pages/tenant-detail.page').then((m) => m.TenantDetailPage)),
  page('leases', 'Leases', FINANCE, () => import('./pages/leases.page').then((m) => m.LeasesPage)),
  page('billing', 'Billing', FINANCE, () => import('./pages/billing.page').then((m) => m.BillingPage)),
  page('payments', 'Payments', FINANCE, () => import('./pages/payments.page').then((m) => m.PaymentsPage)),
  page('receipts/:id', 'Receipt', FINANCE, () => import('./pages/receipt.page').then((m) => m.ReceiptPage)),
  page('deposits', 'Deposits', FINANCE, () => import('./pages/deposits.page').then((m) => m.DepositsPage)),
  page('expenses', 'Expenses', FINANCE, () => import('./pages/expenses.page').then((m) => m.ExpensesPage)),
  page('maintenance', 'Maintenance', ALL, () => import('./pages/maintenance.page').then((m) => m.MaintenancePage)),
  page('documents', 'Documents', FINANCE, () => import('./pages/documents.page').then((m) => m.DocumentsPage)),
  page('reminders', 'Reminders', FINANCE, () => import('./pages/reminders.page').then((m) => m.RemindersPage)),
  page('reports', 'Reports', FINANCE, () => import('./pages/reports.page').then((m) => m.ReportsPage)),
  page('staff', 'Staff & access', ['OWNER'], () => import('./pages/staff.page').then((m) => m.StaffPage)),
  page('account', 'Account & security', [...ALL, 'TENANT'], () => import('./pages/account.page').then((m) => m.AccountPage)),
  page('portal', 'My rental', TENANT, () => import('./pages/portal-home.page').then((m) => m.PortalHomePage)),
  page('portal/payments', 'My payments', TENANT, () => import('./pages/portal-payments.page').then((m) => m.PortalPaymentsPage)),
  {
    ...page('portal/receipts/:id', 'Receipt', TENANT, () => import('./pages/receipt.page').then((m) => m.ReceiptPage)),
    data: { roles: TENANT, source: 'portal' },
  },
  page('portal/repairs', 'Repairs', TENANT, () => import('./pages/portal-repairs.page').then((m) => m.PortalRepairsPage)),
  page('portal/documents', 'Documents', TENANT, () => import('./pages/portal-documents.page').then((m) => m.PortalDocumentsPage)),
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'dashboard' },
];
