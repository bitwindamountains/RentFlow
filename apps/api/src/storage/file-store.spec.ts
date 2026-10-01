import { describe, expect, it } from 'vitest';
import { FileStore, isUploadType, sniffType } from './file-store.service.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('sniffType', () => {
  it('recognises the allowed document formats by their signatures', () => {
    expect(sniffType(text('%PDF-1.7\n...'))).toBe('application/pdf');
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('image/jpeg');
    expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffType(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects everything else, including content that only claims to be allowed', () => {
    expect(sniffType(text('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffType(text('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(sniffType(text('PK\u0003\u0004 docx'))).toBeNull();
    expect(sniffType(bytes())).toBeNull();
  });
});

describe('upload types and keys', () => {
  it('allows only PDF and raster images', () => {
    expect(isUploadType('application/pdf')).toBe(true);
    expect(isUploadType('image/svg+xml')).toBe(false);
    expect(isUploadType('text/html')).toBe(false);
    expect(isUploadType('__proto__')).toBe(false);
  });

  it('builds keys only from server-generated ids', () => {
    const org = '7d1f4a52-2c41-4b8e-9f1e-0a3b5c6d7e8f';
    const id = '0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f';
    expect(FileStore.keyFor(org, id, 'image/png')).toBe(`${org}/${id}.png`);
  });

  it('refuses keys that could escape the storage root', async () => {
    const store = new FileStore();
    await expect(store.get('../../etc/passwd')).rejects.toThrow('Invalid storage key');
    await expect(store.get('7d1f4a52-2c41-4b8e-9f1e-0a3b5c6d7e8f/../x.pdf')).rejects.toThrow('Invalid storage key');
  });
});
