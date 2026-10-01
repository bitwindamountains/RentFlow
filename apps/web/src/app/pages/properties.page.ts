import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { LabelPipe, MoneyPipe, statusTone } from '../core/format';
import type { Property, Unit } from '../core/models';
import { fromCents, sumCents } from '../core/money';

type Form =
  | { kind: 'property'; id?: string; name: string; type: string; address: string; city: string }
  | { kind: 'unit'; id?: string; propertyId: string; number: string; type: string; monthlyRent: string };

@Component({
  selector: 'app-properties-page',
  imports: [FormsModule, RouterLink, MoneyPipe, LabelPipe],
  template: `
<div class="page resource-page">
  <section class="page-heading">
    <div>
      <p class="eyebrow">{{ api.profile()?.organization?.name }}</p>
      <h1>Properties</h1>
      <p>Buildings, units, and who occupies them.</p>
    </div>
    @if (canManage()) {
      <button class="primary" type="button" (click)="openProperty()">Add property</button>
    }
  </section>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }
  @if (notice()) { <p class="inline-notice" role="status">{{ notice() }}</p> }

  @if (form(); as f) {
    <form #editor="ngForm" class="panel operations-form" (ngSubmit)="editor.valid && save()">
      @if (f.kind === 'property') {
        <h2>{{ f.id ? 'Edit property' : 'Add property' }}</h2>
        <fieldset [disabled]="saving()">
          <label class="field"><span>Property name</span><input name="name" [(ngModel)]="f.name" required minlength="2" maxlength="120" /></label>
          <div class="field-row">
            <label class="field"><span>Type</span>
              <select name="type" [(ngModel)]="f.type"><option>Apartment</option><option>Boarding house</option><option>House</option><option>Commercial</option><option>Dormitory</option></select></label>
            <label class="field"><span>City</span><input name="city" [(ngModel)]="f.city" required minlength="2" maxlength="80" /></label>
          </div>
          <label class="field"><span>Street address</span><input name="address" [(ngModel)]="f.address" required minlength="5" maxlength="200" /></label>
        </fieldset>
      } @else {
        <h2>{{ f.id ? 'Edit unit' : 'Add unit' }}</h2>
        <fieldset [disabled]="saving()">
          <div class="field-row">
            <label class="field"><span>Unit number</span><input name="number" [(ngModel)]="f.number" required maxlength="30" /></label>
            <label class="field"><span>Type</span><input name="type" [(ngModel)]="f.type" required minlength="2" maxlength="60" /></label>
          </div>
          <label class="field"><span>Default monthly rent</span>
            <div class="money-input"><b>{{ currency() }}</b><input name="rent" [(ngModel)]="f.monthlyRent" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></div>
            <small>Used for new leases. Active leases keep their agreed rent.</small></label>
        </fieldset>
      }
      <div class="modal-actions">
        <button class="secondary" type="button" [disabled]="saving()" (click)="form.set(null)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !editor.valid">{{ saving() ? 'Saving…' : 'Save' }}</button>
      </div>
    </form>
  }

  <label class="field"><span>Search properties</span><input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)" /></label>
  @if (loading()) { <p role="status">Loading properties…</p> }
  <section class="property-grid">
    @for (p of visible(); track p.id) {
      <article class="property-card">
        <div class="property-body">
          <h2>{{ p.name }}</h2>
          <p>{{ p.address }}, {{ p.city }}</p>
          <p>{{ occupied(p) }} of {{ p.units.length }} units occupied</p>
          <div class="property-meta">
            <span><small>Active monthly rent</small><strong>{{ rent(p) | money }}</strong></span>
            <span><small>Vacant</small><strong>{{ p.units.length - occupied(p) }}</strong></span>
          </div>
          <button class="text-button" type="button" [attr.aria-expanded]="expanded() === p.id" (click)="expanded.set(expanded() === p.id ? '' : p.id)">
            {{ expanded() === p.id ? 'Hide' : 'View' }} units
          </button>
          @if (expanded() === p.id) {
            <ul>
              @for (u of p.units; track u.id) {
                <li>
                  Unit {{ u.number }} · {{ u.type }} · <span [class]="tone(u.status)">{{ u.status | label }}</span>
                  · {{ (u.activeRent ?? u.monthlyRent) | money }}
                  @if (canManage()) { <button class="text-button" type="button" (click)="editUnit(u)">Edit</button> }
                  @if (canManage() && u.status === 'AVAILABLE') { <a class="text-button" routerLink="/leases" [queryParams]="{ unit: u.id }">Lease it</a> }
                </li>
              } @empty { <li>No units yet.</li> }
            </ul>
          }
          @if (canManage()) {
            <button class="text-button" type="button" (click)="openUnit(p.id)">Add unit</button>
            <button class="text-button" type="button" (click)="editProperty(p)">Edit property</button>
          }
        </div>
      </article>
    } @empty {
      @if (!loading()) {
        <p class="empty-cell">No properties yet. @if (canManage()) { <a routerLink="/setup">Use guided setup</a> to add your first rental. }</p>
      }
    }
  </section>
</div>`,
})
export class PropertiesPage implements OnInit {
  protected readonly api = inject(ApiClient);
  protected readonly properties = signal<Property[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly query = signal('');
  protected readonly expanded = signal('');
  protected readonly form = signal<Form | null>(null);
  protected readonly tone = statusTone;
  protected readonly canManage = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected readonly currency = computed(() => this.api.profile()?.organization.currency ?? 'PHP');
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.properties().filter((p) => `${p.name} ${p.address} ${p.city}`.toLowerCase().includes(q));
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.api.get<Property[]>('/properties').subscribe({
      next: (rows) => {
        this.properties.set(rows);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected occupied(p: Property): number {
    return p.units.filter((u) => u.status === 'OCCUPIED').length;
  }
  protected rent(p: Property): string {
    return fromCents(sumCents(p.units.map((u) => u.activeRent)));
  }

  protected openProperty(): void {
    this.form.set({ kind: 'property', name: '', type: 'Apartment', address: '', city: '' });
  }
  protected editProperty(p: Property): void {
    this.form.set({ kind: 'property', id: p.id, name: p.name, type: p.type, address: p.address, city: p.city });
  }
  protected openUnit(propertyId: string): void {
    this.form.set({ kind: 'unit', propertyId, number: '', type: 'Studio', monthlyRent: '' });
  }
  protected editUnit(u: Unit): void {
    this.form.set({ kind: 'unit', id: u.id, propertyId: u.propertyId, number: u.number, type: u.type, monthlyRent: u.monthlyRent });
  }

  protected save(): void {
    const f = this.form();
    if (!f || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    const request =
      f.kind === 'property'
        ? f.id
          ? this.api.patch(`/properties/${f.id}`, { name: f.name, type: f.type, address: f.address, city: f.city })
          : this.api.post('/properties', { name: f.name, type: f.type, address: f.address, city: f.city })
        : f.id
          ? this.api.patch(`/units/${f.id}`, { number: f.number, type: f.type, monthlyRent: f.monthlyRent })
          : this.api.post(`/properties/${f.propertyId}/units`, { number: f.number, type: f.type, monthlyRent: f.monthlyRent });
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.form.set(null);
        this.notice.set('Saved.');
        if (f.kind === 'unit') this.expanded.set(f.propertyId);
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }
}
