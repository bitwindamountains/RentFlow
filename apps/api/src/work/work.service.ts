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
import { StorageService } from '../storage/storage.service.js';
import { decodeCursor, encodeCursor, type Page } from '../common/validation.js';
import { createdCursorWhere, listPage, timeCursor, type ListQuery } from '../common/pagination.js';

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
    private readonly storage: StorageService,
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
  async listMaintenance(organizationId: string, query: ListQuery & { status?: 'active' | 'closed' | 'all' }) {
    const { status } = query;
    const limit = query.limit ?? 50;
    const cursor = timeCursor(query.cursor);
    if (cursor && !(await this.prisma.maintenanceRequest.findFirst({ where: { id: cursor.id, organizationId }, select: { id: true } })))
      throw new DomainError('INVALID_CURSOR', 400);
    const rows = await this.prisma.maintenanceRequest.findMany({
      where: {
        organizationId,
        ...(status === 'active' ? { status: { in: ['OPEN', 'IN_PROGRESS'] } } : {}),
        ...(status === 'closed' ? { status: { in: ['COMPLETED', 'CANCELLED'] } } : {}),
      },
      include: { property: { select: { name: true } }, unit: { select: { number: true } } },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: limit + 1,
    });
    return listPage(rows, limit, maintenanceView, row => row.createdAt);
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
  async listDocuments(organizationId: string, filter: ListQuery & { entityType?: DocumentEntity; entityId?: string }) {
    const limit = filter.limit ?? 50;
    const rows = await this.prisma.documentRecord.findMany({
      where: { organizationId, deletedAt: null, entityType: filter.entityType, entityId: filter.entityId, ...createdCursorWhere(filter.cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return listPage(rows, limit, documentView, row => row.createdAt);
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
        // No name: files are often named after people, and audit rows are never rewritten.
        after: { category: row.category, entityType: row.entityType },
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
    const id = randomUUID();
    const storageKey = FileStore.keyFor(organizationId, id, input.contentType);
    await this.prisma.$transaction(async (tx) => {
      await this.storage.reserve(tx, organizationId, storageKey, body.length);
      await this.assertEntity(tx, organizationId, input);
    });
    try {
      try {
        await this.files.put(storageKey, body, input.contentType);
      } catch (error) {
        this.logger.error(`STORAGE_PUT_FAILED ${(error as Error).name}`);
        throw new DomainError('STORAGE_UNAVAILABLE', 503);
      }
      return await this.prisma.$transaction(async (tx) => {
        await this.storage.finalize(tx, storageKey);
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
          // No name: files are often named after people, and audit rows are never rewritten.
          after: {
            category: row.category,
            entityType: row.entityType,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
          },
        });
        return documentView(row);
      });
    } catch (error) {
      try {
        // A lost commit acknowledgement must never erase a successfully recorded file.
        if (!(await this.prisma.documentRecord.findUnique({ where: { storageKey }, select: { id: true } }))) {
          await this.storage.remove(this.prisma, storageKey);
          await this.storage.processPending(storageKey);
        }
      } catch {
        // The original reservation remains available to the recovery job if the DB is down.
        this.logger.error({ event: 'UPLOAD_CLEANUP_DEFERRED', key: storageKey });
      }
      throw error;
    }
  }

  /** Shares a tenant's or lease's document with the tenant in the portal, or stops sharing it. */
  async setDocumentSharing(organizationId: string, actorUserId: string, id: string, shared: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.documentRecord.findFirst({ where: { id, organizationId, deletedAt: null } });
      if (!row) throw notFound('DOCUMENT_NOT_FOUND');
      if (shared && !(row.entityId && (row.entityType === 'Tenant' || row.entityType === 'Lease')))
        throw new DomainError('DOCUMENT_NOT_SHAREABLE', 422);
      const updated = await tx.documentRecord.update({ where: { id: row.id }, data: { sharedWithTenant: shared } });
      if (row.sharedWithTenant !== shared)
        await audit(tx, {
          organizationId,
          actorUserId,
          action: shared ? 'DOCUMENT_SHARED_WITH_TENANT' : 'DOCUMENT_UNSHARED',
          entityType: 'DocumentRecord',
          entityId: row.id,
        });
      return documentView(updated);
    });
  }

  /**
   * Opens an uploaded file for download after the organization-scoped lookup.
   * `extra` narrows it further (the portal passes its tenant scope).
   */
  async openDocument(organizationId: string, id: string, extra: Prisma.DocumentRecordWhereInput = {}) {
    const row = await this.prisma.documentRecord.findFirst({
      where: { ...extra, id, organizationId, deletedAt: null, storageKey: { not: null } },
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
      if (row.storageKey) await this.storage.remove(tx, row.storageKey);
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'DOCUMENT_REMOVED',
        entityType: 'DocumentRecord',
        entityId: id,
      });
      return row.storageKey;
    });
    if (storageKey) await this.storage.processPending(storageKey).catch(() => {
      this.logger.error({ event: 'STORAGE_CLEANUP_DEFERRED', key: storageKey });
    });
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

export function documentView(row: Prisma.DocumentRecordGetPayload<object>) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    entityType: row.entityType,
    entityId: row.entityId,
    kind: row.storageKey ? ('file' as const) : ('link' as const),
    url: row.url,
    sharedWithTenant: row.sharedWithTenant,
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
