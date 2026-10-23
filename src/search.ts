import { createHash } from 'node:crypto';
import { Client } from './client.js';
import { CLIError, invalid } from './errors.js';

type ContentType = 'all' | 'articles' | 'episodes';
type SearchMode = 'hybrid' | 'keyword';
interface SearchFilters { query: string; type: ContentType; includeArchived: boolean; mode: SearchMode; limit: number; cursor?: string }
interface SearchCursor { v: 1; kind: 'content_search'; token: string; filter: string }

export function searchFilters(input: { query?: string; type?: string; excludeArchived?: boolean; mode?: string; limit?: string; cursor?: string }): SearchFilters {
  const query = input.query?.trim();
  if (!query || Array.from(query).length > 500) invalid('--query must contain 1–500 characters.');
  const type = input.type ?? 'all';
  if (!['all', 'articles', 'episodes'].includes(type)) invalid('--type must be all, articles or episodes.');
  const mode = input.mode ?? 'hybrid';
  if (!['hybrid', 'keyword'].includes(mode)) invalid('--mode must be hybrid or keyword.');
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('--limit must be an integer from 1 to 50.');
  return { query, type: type as ContentType, includeArchived: !input.excludeArchived, mode: mode as SearchMode, limit, cursor: input.cursor };
}

function parseSearchCursor(cursor: string | undefined): SearchCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!cursor || cursor.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value?.v !== 1 || value.kind !== 'content_search' || typeof value.token !== 'string' || !value.token || typeof value.filter !== 'string' || !/^[a-f0-9]{64}$/.test(value.filter)) throw new Error();
    return value;
  } catch { return invalid('Invalid search cursor. Start a new search and use its next_cursor.'); }
}

export async function searchContents(client: Client, filters: SearchFilters): Promise<unknown> {
  const cursor = parseSearchCursor(filters.cursor);
  const account = await client.accountID();
  const filter = createHash('sha256').update(JSON.stringify([client.url, account, filters.query, filters.type, filters.includeArchived, filters.mode])).digest('hex');
  if (cursor && cursor.filter !== filter) invalid('Cursor belongs to different filters, account or API.');
  const params = new URLSearchParams({ q: filters.query, type: filters.type, include_archived: String(filters.includeArchived), mode: filters.mode, limit: String(filters.limit) });
  if (cursor) params.set('cursor', cursor.token);
  const value = await client.request(`/v1/search?${params}`) as { items?: unknown; next_cursor?: unknown; has_more?: unknown; search_mode?: unknown; consistency?: unknown; indexing_status?: unknown; candidate_limit_reached?: unknown } | null;
  if (!value || !Array.isArray(value.items) || !value.items.every(item => item && typeof item === 'object' && typeof item.id === 'string' && ['articles', 'episodes'].includes(item.type) && typeof item.title === 'string' && Array.isArray(item.snippets)) || !(value.next_cursor === null || typeof value.next_cursor === 'string' && value.next_cursor.length > 0) || typeof value.has_more !== 'boolean' || value.has_more !== (value.next_cursor !== null) || value.search_mode !== filters.mode || value.consistency !== 'eventual' || !['ready', 'partial'].includes(String(value.indexing_status)) || typeof value.candidate_limit_reached !== 'boolean') throw new CLIError('invalid_response', 'Invalid server content search response.', 1);
  // Preserve source excerpts and anchors; only the opaque continuation receives a local account/API binding.
  return { ...value, next_cursor: value.next_cursor === null ? null : Buffer.from(JSON.stringify({ v: 1, kind: 'content_search', token: value.next_cursor, filter })).toString('base64url') };
}
