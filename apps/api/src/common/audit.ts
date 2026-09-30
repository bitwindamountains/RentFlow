import { Prisma } from '@prisma/client';
import type { Tx } from './prisma.service.js';

/** Fields that identify a person; audit rows keep only that they changed. */
const personalFields = new Set([
  'email',
  'phone',
  'firstName',
  'lastName',
  'permanentAddress',
  'displayName',
  'passwordHash',
  'url',
]);

export interface AuditEvent {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/**
 * Audit logs are append-only, so personal data is redacted at write time.
 * Erasure requests can then be honoured without rewriting audit history.
 */
export function redact(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (personalFields.has(key)) return item ? '[redacted]' : item;
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Prisma.Decimal) return item.toFixed(2);
      return item;
    }),
  );
}

export async function audit(tx: Tx, event: AuditEvent): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: event.organizationId,
      actorUserId: event.actorUserId ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: redact(event.before),
      after: redact(event.after),
      reason: event.reason,
    },
  });
}
