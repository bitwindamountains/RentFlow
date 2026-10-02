/** Mirrors the API's upload allow-list; the server also checks each file's content. */
export const ACCEPTED_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

/** "PDF · 240 KB" style description of an uploaded file. */
export function describeFile(type: string | null | undefined, size: number | null | undefined): string {
  const kind = ACCEPTED_FILE_TYPES[type ?? ''] ?? 'File';
  if (!size) return kind;
  return size < 1_048_576 ? `${kind} · ${Math.max(1, Math.round(size / 1024))} KB` : `${kind} · ${(size / 1_048_576).toFixed(1)} MB`;
}
