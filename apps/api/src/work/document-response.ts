import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { UPLOAD_TYPES, type UploadType } from '../storage/file-store.service.js';

export interface OpenedDocument {
  body: Readable;
  size?: number;
  name: string;
  contentType: UploadType;
  sha256: string | null;
}

/**
 * Sends a stored file so it can never run in the app's origin: exact type,
 * nosniff, a sandboxing CSP, no caching, and PDFs as downloads.
 */
export function sendDocument(reply: FastifyReply, file: OpenedDocument) {
  // Images open in the browser; PDFs download so they never render inside the app's origin.
  const disposition = file.contentType.startsWith('image/') ? 'inline' : 'attachment';
  const filename = `${file.name.replace(/\.(pdf|jpe?g|png|webp)$/i, '')}.${UPLOAD_TYPES[file.contentType]}`;
  const ascii = filename.replace(/[^\w. -]/g, '_');
  reply
    .header('content-type', file.contentType)
    .header('content-disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (file.size !== undefined) reply.header('content-length', file.size);
  if (file.sha256) reply.header('etag', `"${file.sha256}"`);
  return reply.send(file.body);
}
