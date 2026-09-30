import { Routes } from '@angular/router';
import { DashboardPage } from './pages/dashboard.page';
import { ResourcePage } from './pages/resource.page';
import { AuthPage } from './pages/auth.page';
import { authGuard } from './core/auth.guard';
import { SetupPage } from './pages/setup.page';
import { OperationsPage } from './pages/operations.page';
import { InvitePage } from './pages/invite.page';

export const routes: Routes = [
  { path: 'accept-invite', component: InvitePage, title: 'Accept invitation · RentFlow' },
  {
    path: 'deposits', component: OperationsPage, canActivate: [authGuard], title: 'Deposits · RentFlow',
    data: { kind: 'deposits', title: 'Security deposits', description: 'Keep deposits separate from rental income.', action: 'Record deposit' },
  },
  {
    path: 'reminders', component: OperationsPage, canActivate: [authGuard], title: 'Reminders · RentFlow',
    data: { kind: 'reminders', title: 'Reminders', description: 'Overdue balances, expiring leases, and urgent work.' },
  },
  { path: 'auth', component: AuthPage, title: 'Sign in · RentFlow' },
  {
    path: 'setup',
    component: SetupPage,
    canActivate: [authGuard],
    title: 'Guided setup · RentFlow',
  },
  {
    path: 'dashboard',
    component: DashboardPage,
    canActivate: [authGuard],
    title: 'Dashboard · RentFlow',
  },
  {
    path: 'properties',
    component: ResourcePage,
    canActivate: [authGuard],
    title: 'Properties · RentFlow',
    data: {
      kind: 'properties',
      title: 'Properties',
      description: 'Manage buildings, units, and rentable spaces.',
      action: 'Add property',
    },
  },
  {
    path: 'tenants',
    component: ResourcePage,
    canActivate: [authGuard],
    title: 'Tenants · RentFlow',
    data: {
      kind: 'tenants',
      title: 'Tenants',
      description: 'People, balances, leases, and contact details.',
      action: 'Add tenant',
    },
  },
  {
    path: 'payments',
    component: ResourcePage,
    canActivate: [authGuard],
    title: 'Payments · RentFlow',
    data: {
      kind: 'payments',
      title: 'Payments',
      description: 'Review posted, pending, and reversed payments.',
      action: 'Record payment',
    },
  },
  {
    path: 'leases',
    component: ResourcePage,
    canActivate: [authGuard],
    title: 'Leases · RentFlow',
    data: {
      kind: 'leases',
      title: 'Leases',
      description: 'Track active agreements, renewals, and expirations.',
      action: 'Create lease',
    },
  },
  {
    path: 'billing',
    component: ResourcePage,
    canActivate: [authGuard],
    title: 'Billing · RentFlow',
    data: {
      kind: 'billing',
      title: 'Billing',
      description: 'Generate charges and follow up outstanding balances.',
      action: 'Generate charges',
    },
  },
  {
    path: 'expenses',
    component: OperationsPage,
    canActivate: [authGuard],
    title: 'Expenses · RentFlow',
    data: {
      kind: 'expenses',
      title: 'Expenses',
      description: 'Track property costs, vendors, and supporting documents.',
      action: 'Add expense',
    },
  },
  {
    path: 'maintenance',
    component: OperationsPage,
    canActivate: [authGuard],
    title: 'Maintenance · RentFlow',
    data: {
      kind: 'maintenance',
      title: 'Maintenance',
      description: 'Prioritize requests and coordinate repairs.',
      action: 'New work order',
    },
  },
  {
    path: 'documents',
    component: OperationsPage,
    canActivate: [authGuard],
    title: 'Documents · RentFlow',
    data: {
      kind: 'documents',
      title: 'Documents',
      description: 'Organize secure links to leases, IDs, and property files.',
      action: 'Link document',
    },
  },
  {
    path: 'reports',
    component: OperationsPage,
    canActivate: [authGuard],
    title: 'Reports · RentFlow',
    data: {
      kind: 'reports',
      title: 'Reports',
      description: 'Understand collection, income, expenses, and occupancy.',
    },
  },
  {
    path: 'staff',
    component: OperationsPage,
    canActivate: [authGuard],
    title: 'Staff & access · RentFlow',
    data: {
      kind: 'staff',
      title: 'Staff & access',
      description: 'Invite staff and control operational permissions by role.',
      action: 'Invite staff',
    },
  },
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'dashboard' },
];
