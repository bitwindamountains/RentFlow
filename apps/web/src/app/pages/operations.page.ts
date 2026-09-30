import { DecimalPipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient } from '../core/api-client.service';

@Component({
  selector: 'app-operations-page',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './operations.page.html',
})
export class OperationsPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiClient);
  protected readonly config = this.route.snapshot.data as {
    kind: string;
    title: string;
    description: string;
    action?: string;
  };
  protected readonly records = signal<any[]>([]);
  protected readonly properties = signal<any[]>([]);
  protected readonly leases = signal<any[]>([]);
  protected readonly report = signal<any>(null);
  protected readonly staff = signal<any>({ members: [], invitations: [] });
  protected readonly formOpen = signal(false);
  protected readonly loading = signal(false);
  protected readonly notice = signal('');
  protected readonly error = signal('');
  protected expense: any = {
    category: 'REPAIR',
    description: '',
    vendor: '',
    amount: '',
    incurredOn: new Date().toISOString().slice(0, 10),
    propertyId: '',
  };
  protected maintenance: any = {
    propertyId: '',
    title: '',
    description: '',
    priority: 'MEDIUM',
    assignedTo: '',
  };
  protected document: any = { name: '', category: 'Lease', url: '' };
  protected deposit: any = {
    leaseId: '',
    type: 'RECEIPT',
    amount: '',
    requiredAmount: '',
    reason: '',
  };
  protected invitation: any = { email: '', role: 'MANAGER' };
  protected readonly exportUrl = this.api.downloadUrl('/reports/transactions.csv');
  private depositRequest?: { key: string; body: any; path: string };

  ngOnInit(): void {
    this.load();
  }
  protected canWrite(): boolean {
    const role = this.api.profile()?.role;
    if (this.config.kind === 'staff') return role === 'OWNER';
    return (
      ['OWNER', 'MANAGER'].includes(role ?? '') ||
      (this.config.kind === 'maintenance' && role === 'MAINTENANCE') ||
      (this.config.kind === 'deposits' && role === 'COLLECTOR')
    );
  }
  protected toggleForm(): void {
    this.formOpen.update((value) => !value);
    this.error.set('');
  }

  protected save(): void {
    if (this.loading() || !this.canWrite()) return;
    const kind = this.config.kind;
    let path = '';
    let body: any;
    if (kind === 'expenses') {
      path = '/expenses';
      body = { ...this.expense, propertyId: this.expense.propertyId || undefined };
    } else if (kind === 'maintenance') {
      path = '/maintenance';
      body = this.maintenance;
    } else if (kind === 'documents') {
      path = '/documents';
      body = this.document;
    } else if (kind === 'deposits') {
      path = `/leases/${this.deposit.leaseId}/deposits`;
      body = { ...this.deposit };
      delete body.leaseId;
      if (!body.requiredAmount) delete body.requiredAmount;
    } else if (kind === 'staff') {
      path = '/staff/invitations';
      body = this.invitation;
    } else return;
    this.loading.set(true);
    this.error.set('');
    if (kind === 'deposits') {
      this.depositRequest ??= { key: crypto.randomUUID(), body: structuredClone(body), path };
      path = this.depositRequest.path;
      body = this.depositRequest.body;
    }
    this.api
      .post<any>(path, body, kind === 'deposits' ? this.depositRequest?.key : undefined)
      .subscribe({
        next: (result) => {
          this.loading.set(false);
          this.formOpen.set(false);
          this.depositRequest = undefined;
          this.notice.set(
            kind === 'staff'
              ? `Invitation created. Share this link securely: ${window.location.origin}/accept-invite?token=${result.token}`
              : `${this.config.title} updated successfully.`,
          );
          this.load();
        },
        error: (response) => {
          this.loading.set(false);
          if (
            response.status >= 400 &&
            response.status < 500 &&
            ![408, 409].includes(response.status)
          )
            this.depositRequest = undefined;
          this.error.set(
            this.depositRequest
              ? 'Deposit result is uncertain. Save again to safely retry the original details; do not reload or create another deposit.'
              : (response?.error?.message ?? 'The record could not be saved.'),
          );
        },
      });
  }

  protected completeMaintenance(item: any): void {
    this.api.patch<any>(`/maintenance/${item.id}`, { status: 'COMPLETED' }).subscribe({
      next: () => {
        this.notice.set('Work order completed.');
        this.load();
      },
      error: () => this.error.set('The work order could not be updated.'),
    });
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    const kind = this.config.kind;
    if (kind === 'reports') {
      this.api.get<any>('/reports/financial').subscribe({
        next: (row) => {
          this.report.set(row);
          this.loading.set(false);
        },
        error: () => this.failed(),
      });
      return;
    }
    if (kind === 'staff') {
      this.api.get<any>('/staff').subscribe({
        next: (row) => {
          this.staff.set(row);
          this.loading.set(false);
        },
        error: () => this.failed(),
      });
      return;
    }
    if (kind === 'reminders') {
      this.get('/reminders');
      return;
    }
    if (kind === 'documents') {
      this.get('/documents');
      return;
    }
    if (kind === 'expenses' || kind === 'maintenance') {
      forkJoin({
        records: this.api.get<any[]>(`/${kind}`),
        properties: this.api.get<any[]>('/properties'),
      }).subscribe({
        next: ({ records, properties }) => {
          this.records.set(records);
          this.properties.set(properties);
          if (!this.maintenance.propertyId) this.maintenance.propertyId = properties[0]?.id ?? '';
          this.loading.set(false);
        },
        error: () => this.failed(),
      });
      return;
    }
    if (kind === 'deposits') {
      forkJoin({
        records: this.api.get<any[]>('/deposits'),
        leases: this.api.get<any[]>('/leases'),
      }).subscribe({
        next: ({ records, leases }) => {
          this.records.set(records);
          this.leases.set(leases.filter((item) => item.status === 'ACTIVE'));
          if (!this.deposit.leaseId) this.deposit.leaseId = this.leases()[0]?.id ?? '';
          this.loading.set(false);
        },
        error: () => this.failed(),
      });
      return;
    }
    this.loading.set(false);
  }
  private get(path: string): void {
    this.api.get<any[]>(path).subscribe({
      next: (rows) => {
        this.records.set(rows);
        this.loading.set(false);
      },
      error: () => this.failed(),
    });
  }
  private failed(): void {
    this.error.set('Live data could not be loaded. Please try again.');
    this.loading.set(false);
  }
}
