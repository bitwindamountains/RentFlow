import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiClient } from '../core/api-client.service';

/**
 * Public privacy notice (Data Privacy Act of 2012, RA 10173). Lists what the
 * app stores; keep it in step with apps/api/prisma/schema.prisma.
 */
@Component({
  selector: 'app-privacy-page',
  imports: [RouterLink],
  template: `
<main class="privacy-page">
  <article class="panel">
    <a class="auth-brand" routerLink="/auth"><span>R</span>RentFlow</a>
    <p class="eyebrow">PRIVACY NOTICE</p>
    <h1>How RentFlow handles your personal information</h1>
    <p>RentFlow is used by landlords and property managers to run their rentals. Each landlord’s workspace is separate. The landlord decides what is recorded about their tenants and staff, and RentFlow stores and processes it for them under the Data Privacy Act of 2012 (Republic Act No. 10173).</p>

    <h2>What we store</h2>
    <ul>
      <li><strong>Staff and tenant accounts:</strong> name, email address, a scrambled (hashed) form of the password, sign-in sessions with the device’s browser name, and, if turned on, an encrypted two-step sign-in key.</li>
      <li><strong>Tenant records:</strong> name, email address, phone number, permanent address, leases, units, rent, deposits, charges, payments, receipts, and payment references such as GCash or bank reference numbers.</li>
      <li><strong>Documents:</strong> files the landlord or tenant uploads, such as signed leases, IDs, and payment screenshots.</li>
      <li><strong>Requests:</strong> payment reports and repair requests a tenant sends through the portal.</li>
      <li><strong>Activity records:</strong> who changed what and when. Names, emails, phone numbers and document links are left out of these records.</li>
    </ul>

    <h2>Why</h2>
    <p>To manage leases and rent, issue receipts, keep accurate financial records, let tenants see their balances and report payments, send account and payment emails, and keep accounts secure. We do not sell personal information or use it for advertising.</p>

    <h2>Who can see it</h2>
    <ul>
      <li>The landlord’s staff, limited by their role.</li>
      <li>A tenant sees only their own records and the documents the landlord shares with them.</li>
      <li>Service providers that run RentFlow for us: hosting, database, file storage and email delivery. They process data only to provide those services.</li>
    </ul>

    <h2>How long we keep it</h2>
    <p>While the lease or account is active, and afterwards for as long as the landlord needs it for its records. Financial records such as charges, payments and receipts are kept for as long as tax and accounting laws require. When a tenant’s personal details are erased, these records stay but no longer show who the tenant was.</p>

    <h2>How it is protected</h2>
    <p>Connections are encrypted. Passwords are stored only in hashed form. Uploaded files are private and only reachable after a permission check. Sign-in is rate-limited, and two-step sign-in is available to everyone.</p>

    <h2>Your rights</h2>
    <p>You may ask to be informed about, see, correct, or get a copy of your personal information; object to its processing; or ask for it to be erased or blocked. You may also complain to the National Privacy Commission (privacy.gov.ph).</p>
    <p>
      Tenants and staff should first contact their landlord or workspace owner, who can export or erase their details.
      @if (contact(); as email) { You can also write to us at <a [href]="'mailto:' + email">{{ email }}</a>. }
    </p>

    <p class="privacy-back"><a routerLink="/auth">Back to RentFlow</a></p>
  </article>
</main>`,
  styles: `
    .privacy-page { min-height: 100dvh; padding: var(--space-6) var(--space-4); background: var(--canvas); }
    .privacy-page article { max-width: 46rem; margin: 0 auto; padding: var(--space-6); line-height: 1.65; }
    .privacy-page h1 { margin: var(--space-2) 0 var(--space-4); font-size: var(--text-2xl); line-height: 1.25; }
    .privacy-page h2 { margin: var(--space-6) 0 var(--space-2); font-size: var(--text-lg); }
    .privacy-page ul { padding-left: 1.2em; }
    .privacy-page li + li { margin-top: var(--space-2); }
    .privacy-page .auth-brand { display: inline-flex; margin-bottom: var(--space-5); }
    .privacy-back { margin-top: var(--space-6); }
  `,
})
export class PrivacyPage {
  protected readonly contact = signal<string | null>(null);

  constructor() {
    inject(ApiClient)
      .get<{ contactEmail: string | null }>('/privacy')
      .subscribe({ next: (result) => this.contact.set(result.contactEmail), error: () => undefined });
  }
}
