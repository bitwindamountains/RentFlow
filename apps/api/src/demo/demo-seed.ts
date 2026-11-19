import { type PaymentMethod, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { BalancesService } from '../billing/balances.service.js';
import type { BillingService } from '../billing/billing.service.js';
import { addDays, dateOf, periodOf } from '../common/dates.js';
import { formatMoney } from '../common/money.js';
import type { PaymentsService } from '../payments/payments.service.js';
import type { PropertiesService } from '../rentals/properties.service.js';
import type { RentalSetupService } from '../rentals/setup.service.js';
import type { WorkService } from '../work/work.service.js';

export interface DemoSeedServices {
  setup: RentalSetupService;
  properties: PropertiesService;
  billing: BillingService;
  balances: BalancesService;
  payments: PaymentsService;
  work: WorkService;
}

/** How a sample tenant has paid: in full, part of last month, or nothing for the last two months. */
type Standing = 'paid' | 'partial' | 'overdue';

interface SampleRental {
  property: 'Mabini Residences' | 'Sampaguita Apartments';
  unit: string;
  firstName: string;
  lastName: string;
  phone: string;
  rent: string;
  monthsAgo: number;
  standing: Standing;
  /** Days from today the lease ends; otherwise a one-year lease. */
  endsInDays?: number;
  deposit?: string;
}

const PROPERTIES = {
  'Mabini Residences': { type: 'Apartment', address: '128 Mabini Street, Barangay San Roque', city: 'Quezon City' },
  'Sampaguita Apartments': { type: 'Apartment', address: '45 Sampaguita Lane, Barangay Malanday', city: 'Marikina City' },
} as const;

const RENTALS: SampleRental[] = [
  { property: 'Mabini Residences', unit: '1A', firstName: 'Maria', lastName: 'Santos', phone: '0917 000 0101', rent: '8500.00', monthsAgo: 5, standing: 'paid', deposit: '17000.00' },
  { property: 'Mabini Residences', unit: '1B', firstName: 'Jose', lastName: 'Reyes', phone: '0917 000 0102', rent: '12000.00', monthsAgo: 4, standing: 'paid' },
  { property: 'Mabini Residences', unit: '2A', firstName: 'Ana', lastName: 'Cruz', phone: '0917 000 0103', rent: '9500.00', monthsAgo: 3, standing: 'paid' },
  { property: 'Sampaguita Apartments', unit: '101', firstName: 'Mark', lastName: 'Bautista', phone: '0917 000 0104', rent: '15000.00', monthsAgo: 4, standing: 'partial' },
  { property: 'Sampaguita Apartments', unit: '102', firstName: 'Liza', lastName: 'Garcia', phone: '0917 000 0105', rent: '7000.00', monthsAgo: 4, standing: 'overdue', endsInDays: 20 },
];

const METHODS: PaymentMethod[] = ['CASH', 'GCASH', 'BANK_TRANSFER', 'MAYA'];

/** First day of the month `monthsAgo` months before `today`. */
function monthStart(today: string, monthsAgo: number): string {
  return dateOf(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - monthsAgo, 1);
}

/**
 * Fills a new demo workspace with a lived-in landlord's month, through the same
 * services the app uses, so balances, receipts and arrears are real.
 */
export async function seedDemo(services: DemoSeedServices, organizationId: string, actorUserId: string, today: string): Promise<void> {
  const { setup, properties, billing, balances, payments, work } = services;
  const leases: Array<{ rental: SampleRental; leaseId: string; tenantId: string; propertyId: string; unitId: string }> = [];

  for (const rental of RENTALS) {
    const startDate = monthStart(today, rental.monthsAgo);
    const endDate = rental.endsInDays !== undefined ? addDays(today, rental.endsInDays) : addDays(monthStart(today, rental.monthsAgo - 12), -1);
    const created = await setup.create(organizationId, actorUserId, randomUUID(), {
      property: { name: rental.property, ...PROPERTIES[rental.property] },
      unit: { number: rental.unit, type: 'Studio', monthlyRent: rental.rent },
      tenant: {
        firstName: rental.firstName,
        lastName: rental.lastName,
        email: `${rental.firstName}.${rental.lastName}@example.com`.toLowerCase(),
        phone: rental.phone,
      },
      lease: {
        startDate,
        endDate,
        monthlyRent: rental.rent,
        billingDay: 1,
        dueDay: 5,
        gracePeriodDays: 0,
        ...(rental.deposit ? { depositRequired: rental.deposit } : {}),
        firstMonth: 'FULL',
      },
      charge: { description: `Rent for ${periodOf(startDate)}`, dueDate: addDays(startDate, 4), billingPeriod: periodOf(startDate) },
    });
    leases.push({ rental, leaseId: created.leaseId, tenantId: created.tenantId, propertyId: created.propertyId, unitId: created.unitId });
  }

  const mabini = leases.find((lease) => lease.rental.property === 'Mabini Residences')!;
  await properties.createUnit(organizationId, actorUserId, mabini.propertyId, { number: '2B', type: 'Studio', monthlyRent: '10500.00' });

  // Post every month since each move-in, as the background job would have.
  await billing.runBilling(organizationId, null, today);

  const lastMonth = periodOf(monthStart(today, 1));
  const thisMonth = periodOf(today);
  let method = 0;
  for (const lease of leases) {
    const charges = (await balances.charges(organizationId, { leaseId: lease.leaseId, status: 'open' }))
      .slice()
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const charge of charges) {
      let amount = new Prisma.Decimal(charge.outstanding);
      if (lease.rental.standing === 'overdue' && (charge.billingPeriod === lastMonth || charge.billingPeriod === thisMonth)) continue;
      if (lease.rental.standing === 'partial' && charge.billingPeriod === lastMonth) amount = amount.div(2).toDecimalPlaces(2);
      const paidAt = charge.dueDate.getTime() < Date.now() ? charge.dueDate : new Date();
      await payments.create(
        organizationId,
        actorUserId,
        {
          tenantId: lease.tenantId,
          leaseId: lease.leaseId,
          amount: formatMoney(amount),
          method: METHODS[method++ % METHODS.length]!,
          paidAt: paidAt.toISOString(),
          allocations: [{ chargeId: charge.id, amount: formatMoney(amount) }],
        },
        randomUUID(),
      );
    }
  }

  const first = leases[0]!;
  await payments.recordDeposit(organizationId, actorUserId, first.leaseId, { type: 'RECEIPT', amount: first.rental.deposit! }, randomUUID());
  await work.createExpense(organizationId, actorUserId, {
    propertyId: first.propertyId,
    category: 'REPAIR',
    description: 'Replaced the water heater in Unit 1A',
    vendor: 'Dela Cruz Plumbing',
    amount: '3500.00',
    incurredOn: addDays(today, -10),
  });
  const sampaguita = leases.find((lease) => lease.rental.property === 'Sampaguita Apartments')!;
  await work.createMaintenance(organizationId, actorUserId, {
    propertyId: sampaguita.propertyId,
    unitId: sampaguita.unitId,
    title: 'Leaking kitchen faucet',
    description: 'The tenant reports a steady drip under the kitchen sink.',
    priority: 'MEDIUM',
  });
}
