import { api, unwrapList, type RequestOpts } from '../../api/client';

/** Read every authorized page so settings and history never silently omit records. */
export async function readAll<T>(path: string, query: RequestOpts['query'] = {}): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const data = await api<unknown>(path, { query: { ...query, limit: 500, offset: rows.length } });
    const page = unwrapList<T>(data);
    rows.push(...page);
    const total = data && typeof data === 'object' && 'total' in data ? Number(data.total) : rows.length;
    if (!page.length || rows.length >= total) return rows;
  }
}
