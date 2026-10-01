import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ExpenseCategory, MaintenancePriority, MaintenanceStatus, Prisma } from '@prisma/client';
import { audit } from '../common/audit.js';
import { formatDateOnly, parseDateOnly } from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { formatMoney, parseMoney } from '../common/money.js';
import { PrismaService } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { FileStore, sniffType, type UploadType } from '../storage/file-store.service.js';
import { decodeCursor, encodeCursor, type Page } from '../common/validation.js';

const transitions: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  OPEN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['OPEN', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['OPEN'],
  CANCELLED: ['OPEN'],
};

export const DOCUMENT_ENTITIES = ['Tenant', 'Lease', 'Property', 'Unit', 'Expense', 'MaintenanceRequest', 'PaymentNotice'] as const;
export type DocumentEntity = (typeof DOCUMENT_ENTITIES)[number];

interface DocumentMeta {
  name: string;
  category: string;
  entityType?: DocumentEntity;
  entityId?: string;
}

@Injectable()
export class WorkService {
  private readonly logger = new Logger(WorkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileStore,
  ) {}

  // ---------------------------------------------------------------- expenses
  async listExpenses(
    organizationId: string,
    query: { cursor?: string; limit?: number; propertyId?: string; includeVoided?: boolean },
  ): Promise<Page<ReturnType<typeof expenseView>>> {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.expense.findMany({
      where: {
        organizationId,
        ...(query.propertyId ? { propertyId: query.propertyId } : {}),
        ...(query.includeVoided ? {} : { voidedAt: null }),
        ...(cursor
          ? {
              OR: [
                { incurredOn: { lt: parseDateOnly(cursor.sortValue) } },
                { incurredOn: parseDateOnly(cursor.sortValue), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { property: { select: { name: true } } },
      orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map(expenseView);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.incurredOn, last.id) : null };
  }

  async createExpense(
    organizationId: string,
    actorUserId: string,
    input: {
      propertyId?: string;
      category: ExpenseCategory;
      description: string;
      vendor?: string;
      amount: string;
      incurredOn: string;
      reference?: string;
    },
  ) {
    const amount = parseMoney(input.amount);
    return this.prisma.$transaction(async (tx) => {
      if (input.propertyId && !(await tx.property.findFirst({ where: { id: input.propertyId, organizationId } })))
        throw notFound('PROPERTY_NOT_FOUND');
      const row = await tx.expense.create({
        data: {
          organizationId,
          propertyId: input.propertyId,
          category: input.category,
          description: input.description.trim(),
          vendor: input.vendor?.trim() || undefined,
          amount,
          incurredOn: parseDateOnly(input.incurredOn),
          reference: input.reference?.trim() || undefined,
          createdBy: actorUserId,
        },
        include: { property: { select: { name: true } } },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'EXPENSE_CREATED',
        entityType: 'Expense',
        entityId: row.id,
        after: row,
      });
      return expenseView(row);
    });
  }

  /** Expenses entered in error are voided (kept for audit), never deleted. */
  async voidExpense(organizationId: string, actorUserId: string, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.expense.updateMany({
        where: { id, organizationId, voidedAt: null },
        data: { voidedAt: new Date(), voidReason: reason.trim() },
      });
      if (!updated.count) throw notFound();
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'EXPENSE_VOIDED',
        entityType: 'Expense',
        entityId: id,
        reason,
      });
      return { id, voided: true };
    });
  }

  // ------------------------------------------------------------- maintenance
  async listMaintenance(organizationId: string, status?: 'active' | 'closed' | 'all') {
    const rows = await this.prisma.maintenanceRequest.findMany({
      where: {
        organizationId,
        ...(status === 'active' ? { status: { in: ['OPEN', 'IN_PROGRESS'] } } : {}),
        ...(status === 'closed' ? { status: { in: ['COMPLETED', 'CANCELLED'] } } : {}),
      },
      include: { property: { select: { name: true } }, unit: { select: { number: true } } },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return rows.map(maintenanceView);
  }

  async createMaintenance(
    organizationId: string,
    actorUserId: string,
    input: {
      propertyId: string;
      unitId?: string;
      title: string;
      description: string;
      priority: MaintenancePriority;
      assignedTo?: string;
      dueOn?: string;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.property.findFirst({ where: { id: input.propertyId, organizationId } })))
        throw notFound('PROPERTY_NOT_FOUND');
      if (input.unitId && !(await tx.unit.findFirst({ where: { id: input.unitId, organizationId, propertyId: input.propertyId } })))
        throw notFound();
      const row = await tx.maintenanceRequest.create({
        data: {
          organizationId,
          propertyId: input.propertyId,
          unitId: input.unitId,
          title: input.title.trim(),
          description: input.description.trim(),
          priority: input.priority,
          assignedTo: input.assignedTo?.trim() || undefined,
          dueOn: input.dueOn ? parseDateOnly(input.dueOn) : undefined,
          reportedBy: actorUserId,
        },
        include: { property: { select: { name: true } }, unit: { select: { number: true } } },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'MAINTENANCE_CREATED',
        entityType: 'MaintenanceRequest',
        entityId: row.id,
        after: row,
      });
      return maintenanceView(row);
    });
  }

  async updateMaintenance(
    organizationId: string,
    actorUserId: string,
    id: string,
    input: {
      status?: MaintenanceStatus;
      priority?: MaintenancePriority;
      assignedTo?: string | null;
      title?: string;
      description?: string;
      dueOn?: string | null;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.maintenanceRequest.findFirst({ where: { id, organizationId } });
      if (!before) throw notFound('MAINTENANCE_NOT_FOUND');
      if (input.status && input.status !== before.status && !transitions[before.status].includes(input.status))
        throw new DomainError('INVALID_TRANSITION', 422);
      const statusChanged = input.status && input.status !== before.status;
      const data: Prisma.MaintenanceRequestUpdateInput = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo?.trim() || null } : {}),
        ...(input.title ? { title: input.title.trim() } : {}),
        ...(input.description ? { description: input.description.trim() } : {}),
        ...(input.dueOn !== undefined ? { dueOn: input.dueOn ? parseDateOnly(input.dueOn) : null } : {}),
        ...(statusChanged ? { completedAt: input.status === 'COMPLETED' ? new Date() : null } : {}),
      };
      const after = await tx.maintenanceRequest.update({
        where: { id },
        data,
        include: { property: { select: { name: true } }, unit: { select: { number: true } } },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'MAINTENANCE_UPDATED',
        entityType: 'MaintenanceRequest',
        entityId: id,
        before: { status: before.status, priority: before.priority },
        after: { status: after.status, priority: after.priority },
      });
      return maintenanceView(after);
    });
  }

  // --------------------------------------------------------------- documents
  async listDocuments(organizationId: string, filter: { entityType?: DocumentEntity; entityId?: string }) {
    const rows = await this.prisma.documentRecord.findMany({
      where: { organizationId, deletedAt: null, ...filter },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(documentView);
  }

  async createDocument(
    organizationId: string,
    actorUserId: string,
    input: { name: string; category: string; entityType?: DocumentEntity; entityId?: string; url: string },
  ) {
    assertEntityPair(input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertEntity(tx, organizationId, input);
      const row = await tx.documentRecord.create({
        data: {
          organizationId,
          name: input.name.trim(),
          category: input.category.trim(),
          entityType: input.entityType,
          entityId: input.entityId,
          url: input.url.trim(),
          createdBy: actorUserId,
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'DOCUMENT_LINKED',
        entityType: 'DocumentRecord',
        entityId: row.id,
        after: { name: row.name, category: row.category, entityType: row.entityType },
      });
      return documentView(row);
    });
  }

  /**
   * Stores an uploaded file privately, then records it. The declared type must match the
   * file's own signature, so a renamed HTML or script file is rejected.
   */
  async uploadDocument(
    organizationId: string,
    actorUserId: string,
    input: DocumentMeta & { contentType: UploadType },
    body: Buffer,
  ) {
    assertEntityPair(input);
    if (!body.length) throw new DomainError('FILE_EMPTY', 400);
    if (body.length > environment().UPLOAD_MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 413);
    if (sniffType(body) !== input.contentType) throw new DomainError('FILE_TYPE_MISMATCH', 415);
    await this.assertEntity(this.prisma, organizationId, input);
    const used = await this.prisma.documentRecord.aggregate({
      where: { organizationId, deletedAt: null, storageKey: { not: null } },
      _sum: { sizeBytes: true },
    });
    if ((used._sum.sizeBytes ?? 0) + body.length > environment().STORAGE_QUOTA_BYTES)
      throw new DomainError('STORAGE_QUOTA_EXCEEDED', 413);

    const id = randomUUID();
    const storageKey = FileStore.keyFor(organizationId, id, input.contentType);
    try {
      await this.files.put(storageKey, body, input.contentType);
    } catch (error) {
      this.logger.error(`STORAGE_PUT_FAILED ${(error as Error).name}`);
      throw new DomainError('STORAGE_UNAVAILABLE', 503);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertEntity(tx, organizationId, input);
        const row = await tx.documentRecord.create({
          data: {
            id,
            organizationId,
            name: input.name.trim(),
            category: input.category.trim(),
            entityType: input.entityType,
            entityId: input.entityId,
            storageKey,
            contentType: input.contentType,
            sizeBytes: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
            createdBy: actorUserId,
          },
        });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'DOCUMENT_UPLOADED',
          entityType: 'DocumentRecord',
          entityId: row.id,
          after: {
            name: row.name,
            category: row.category,
            entityType: row.entityType,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
          },
        });
        return documentView(row);
      });
    } catch (error) {
      await this.files.delete(storageKey); // never leave an unrecorded file behind
      throw error;
    }
  }

  /** Opens an uploaded file for download after the organization-scoped lookup. */
  async openDocument(organizationId: string, id: string) {
    const row = await this.prisma.documentRecord.findFirst({
      where: { id, organizationId, deletedAt: null, storageKey: { not: null } },
    });
    if (!row?.storageKey || !row.contentType) throw notFound('DOCUMENT_NOT_FOUND');
    const file = await this.files.get(row.storageKey);
    if (!file) {
      this.logger.error(`STORAGE_OBJECT_MISSING document=${row.id}`);
      throw notFound('DOCUMENT_NOT_FOUND');
    }
    return { ...file, name: row.name, contentType: row.contentType as UploadType, sha256: row.sha256 };
  }

  /** The record stays for the audit trail; an uploaded file is erased from storage. */
  async deleteDocument(organizationId: string, actorUserId: string, id: string) {
    const storageKey = await this.prisma.$transaction(async (tx) => {
      const row = await tx.documentRecord.findFirst({
        where: { id, organizationId, deletedAt: null },
        select: { storageKey: true },
      });
      const updated = await tx.documentRecord.updateMany({
        where: { id, organizationId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (!updated.count || !row) throw notFound('DOCUMENT_NOT_FOUND');
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'DOCUMENT_REMOVED',
        entityType: 'DocumentRecord',
        entityId: id,
      });
      return row.storageKey;
    });
    if (storageKey) await this.files.delete(storageKey);
    return { deleted: true };
  }

  private async assertEntity(tx: Prisma.TransactionClient, organizationId: string, input: DocumentMeta) {
    if (input.entityType && input.entityId && !(await this.entityExists(tx, organizationId, input.entityType, input.entityId)))
      throw notFound();
  }

  private async entityExists(tx: Prisma.TransactionClient, organizationId: string, type: DocumentEntity, id: string) {
    const where = { id, organizationId };
    switch (type) {
      case 'Tenant':
        return Boolean(await tx.tenant.findFirst({ where, select: { id: true } }));
      case 'Lease':
        return Boolean(await tx.lease.findFirst({ where, select: { id: true } }));
      case 'Property':
        return Boolean(await tx.property.findFirst({ where, select: { id: true } }));
      case 'Unit':
        return Boolean(await tx.unit.findFirst({ where, select: { id: true } }));
      case 'Expense':
        return Boolean(await tx.expense.findFirst({ where, select: { id: true } }));
      case 'MaintenanceRequest':
        return Boolean(await tx.maintenanceRequest.findFirst({ where, select: { id: true } }));
      case 'PaymentNotice':
        return Boolean(await tx.paymentNotice.findFirst({ where, select: { id: true } }));
    }
  }
}

function assertEntityPair(input: DocumentMeta): void {
  if (Boolean(input.entityType) !== Boolean(input.entityId))
    throw new DomainError('RESOURCE_NOT_FOUND', 422, 'Choose both the record type and the record.');
}

function documentView(row: Prisma.DocumentRecordGetPayload<object>) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    entityType: row.entityType,
    entityId: row.entityId,
    kind: row.storageKey ? ('file' as const) : ('link' as const),
    url: row.url,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

function expenseView(row: Prisma.ExpenseGetPayload<{ include: { property: { select: { name: true } } } }>) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property?.name ?? null,
    category: row.category,
    description: row.description,
    vendor: row.vendor,
    amount: formatMoney(row.amount),
    incurredOn: formatDateOnly(row.incurredOn),
    reference: row.reference,
    voided: Boolean(row.voidedAt),
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function maintenanceView(
  row: Prisma.MaintenanceRequestGetPayload<{
    include: { property: { select: { name: true } }; unit: { select: { number: true } } };
  }>,
) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property.name,
    unitId: row.unitId,
    unitNumber: row.unit?.number ?? null,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    assignedTo: row.assignedTo,
    reportedByTenant: row.tenantId !== null,
    dueOn: row.dueOn ? formatDateOnly(row.dueOn) : null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
