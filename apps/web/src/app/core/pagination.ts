/** Updated records may cross a page boundary; keep one current copy of each. */
export function appendPage<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return [...new Map([...current, ...incoming].map(item => [item.id, item])).values()];
}
