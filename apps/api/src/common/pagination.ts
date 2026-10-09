import type { FastifyReply } from 'fastify';
import { DomainError } from './errors.js';
import { decodeCursor, encodeCursor, type Page } from './validation.js';

export type ListQuery = { cursor?: string; limit?: number };

export function timeCursor(value?: string) {
  if (!value) return undefined;
  const cursor = decodeCursor(value);
  if (!cursor || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.sortValue) || !Number.isFinite(Date.parse(cursor.sortValue))
    || new Date(cursor.sortValue).toISOString() !== cursor.sortValue)
    throw new DomainError('INVALID_CURSOR', 400);
  return { date: new Date(cursor.sortValue), id: cursor.id };
}

export function createdCursorWhere(value?: string, direction: 'asc' | 'desc' = 'desc') {
  const cursor = timeCursor(value);
  if (!cursor) return {};
  return direction === 'desc'
    ? { OR: [{ createdAt: { lt: cursor.date } }, { createdAt: cursor.date, id: { lt: cursor.id } }] }
    : { OR: [{ createdAt: { gt: cursor.date } }, { createdAt: cursor.date, id: { gt: cursor.id } }] };
}

export function listPage<Row extends { id: string }, Item>(rows: Row[], limit: number, view: (row: Row) => Item, sort: (row: Row) => Date): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return { items: visible.map(view), nextCursor: rows.length > limit && last ? encodeCursor(sort(last).toISOString(), last.id) : null };
}

/** Preserve array response bodies for existing clients; newer clients can request the next page. */
export function arrayPage<T>(reply: FastifyReply, page: Page<T>): T[] {
  reply.header('x-next-cursor', page.nextCursor ?? '');
  return page.items;
}
