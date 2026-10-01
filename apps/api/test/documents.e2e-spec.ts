import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createRental, PASSWORD, prismaOf, registerOwner, startApp, unique } from './helpers.js';

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF')]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe('document uploads', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let organizationId: string;

  const upload = (client: Client, body: Buffer, type: string, query = 'name=Signed%20lease&category=Lease') =>
    client.request('POST', `/documents/files?${query}`, body, { 'content-type': type });

  async function member(role: string) {
    const email = `${role.toLowerCase()}-${unique()}@rentflow.test`;
    const invite = await owner.post('/staff/invitations', { email, role });
    await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: `${role} person`, password: PASSWORD });
    const client = new Client(app);
    await client.post('/auth/login', { email, password: PASSWORD });
    return client;
  }

  async function storedFiles(): Promise<string[]> {
    try {
      return await readdir(join(process.env['STORAGE_DIR']!, organizationId));
    } catch {
      return [];
    }
  }

  beforeAll(async () => {
    app = await startApp();
    const registered = await registerOwner(app);
    owner = registered.client;
    organizationId = registered.profile.organization.id;
  });
  afterAll(async () => app.close());

  it('stores a PDF privately and serves the exact bytes only to the workspace', async () => {
    const rental = await createRental(owner);
    const created = await upload(owner, pdf, 'application/pdf', `name=Lease%20${unique()}&category=Lease&entityType=Tenant&entityId=${rental.tenant.id}`);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'file', url: null, contentType: 'application/pdf', sizeBytes: pdf.length });

    const listed = (await owner.get(`/documents?entityType=Tenant&entityId=${rental.tenant.id}`)).body;
    expect(listed.map((d: { id: string }) => d.id)).toContain(created.body.id);

    const download = await owner.get(`/documents/${created.body.id}/file`);
    expect(download.status).toBe(200);
    expect(download.raw.equals(pdf)).toBe(true);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment; filename=".+\.pdf"/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toBe('private, no-store');
    expect(download.headers['etag']).toBe(`"${createHash('sha256').update(pdf).digest('hex')}"`);

    // Images open inline, still under a sandboxing CSP.
    const image = await upload(owner, png, 'image/png', 'name=Meter%20photo.png&category=Property');
    const shown = await owner.get(`/documents/${image.body.id}/file`);
    expect(String(shown.headers['content-disposition'])).toMatch(/^inline; filename="Meter photo\.png"/);
    expect(String(shown.headers['content-security-policy'])).toContain('sandbox');
  });

  it('rejects files whose content does not match an allowed type', async () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    expect((await upload(owner, html, 'application/pdf')).body.code).toBe('FILE_TYPE_MISMATCH');
    expect((await upload(owner, png, 'application/pdf')).status).toBe(415);
    expect((await upload(owner, html, 'text/html')).status).toBe(415);
    expect((await upload(owner, Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415);
    // Too large for UPLOAD_MAX_MB=1 (set for the e2e run).
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1_048_576 + 10)]);
    expect((await upload(owner, big, 'application/pdf')).status).toBe(413);
    // Raw file bodies are not accepted anywhere else.
    expect((await owner.request('POST', '/expenses', pdf, { 'content-type': 'application/pdf' })).status).toBe(415);
    // Metadata is still validated, and nothing is left in storage on failure.
    const before = await storedFiles();
    expect((await upload(owner, pdf, 'application/pdf', 'name=x&category=Lease')).status).toBe(400);
    expect((await upload(owner, pdf, 'application/pdf', `name=Lease&category=Lease&entityType=Tenant&entityId=${crypto.randomUUID()}`)).status).toBe(404);
    expect(await storedFiles()).toEqual(before);
  });

  it('keeps files away from other workspaces and from roles that cannot manage documents', async () => {
    const created = await upload(owner, pdf, 'application/pdf');
    const outsider = (await registerOwner(app)).client;
    expect((await outsider.get(`/documents/${created.body.id}/file`)).status).toBe(404);
    expect((await outsider.delete(`/documents/${created.body.id}`)).status).toBe(404);
    expect((await new Client(app).get(`/documents/${created.body.id}/file`)).status).toBe(401);

    const viewer = await member('VIEWER');
    expect((await viewer.get(`/documents/${created.body.id}/file`)).status).toBe(200);
    expect((await upload(viewer, pdf, 'application/pdf')).status).toBe(403);
    const maintenance = await member('MAINTENANCE');
    expect((await maintenance.get(`/documents/${created.body.id}/file`)).status).toBe(403);

    // Uploads need the CSRF header like every other write.
    const noCsrf = await owner.request('POST', '/documents/files?name=Lease&category=Lease', pdf, {
      'content-type': 'application/pdf',
      'x-csrf-token': '',
    });
    expect(noCsrf.status).toBe(403);
  });

  it('erases the stored file when the document is removed and keeps the audit record', async () => {
    const created = await upload(owner, pdf, 'application/pdf');
    const key = `${created.body.id}.pdf`;
    expect(await storedFiles()).toContain(key);
    expect((await owner.delete(`/documents/${created.body.id}`)).status).toBe(200);
    expect(await storedFiles()).not.toContain(key);
    expect((await owner.get(`/documents/${created.body.id}/file`)).status).toBe(404);
    const row = await prismaOf(app).documentRecord.findUnique({ where: { id: created.body.id } });
    expect(row?.deletedAt).not.toBeNull();
    const actions = await prismaOf(app).auditLog.findMany({ where: { entityId: created.body.id }, select: { action: true } });
    expect(actions.map((a) => a.action).sort()).toEqual(['DOCUMENT_REMOVED', 'DOCUMENT_UPLOADED']);
  });

  it('enforces the workspace storage quota', async () => {
    const other = await registerOwner(app);
    const nearlyFull = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1_000_000)]);
    let status = 201;
    for (let i = 0; i < 12 && status === 201; i += 1) status = (await upload(other.client, nearlyFull, 'application/pdf')).status;
    // STORAGE_QUOTA_MB=10 for the e2e run: the eleventh ~1 MB file is refused.
    expect(status).toBe(413);
  });

  it('still supports external links, and a document is never both', async () => {
    const link = await owner.post('/documents', { name: 'Drive copy', category: 'Lease', url: 'https://drive.google.com/file/d/abc' });
    expect(link.body).toMatchObject({ kind: 'link', url: 'https://drive.google.com/file/d/abc', contentType: null });
    expect((await owner.get(`/documents/${link.body.id}/file`)).status).toBe(404);
    await expect(
      prismaOf(app).documentRecord.update({ where: { id: link.body.id }, data: { storageKey: `${organizationId}/${link.body.id}.pdf` } }),
    ).rejects.toThrow();
  });
});

