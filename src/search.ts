import { createHash } from 'node:crypto';
import { Client } from './client.js';
import { CLIError, invalid } from './errors.js';

type ContentType = 'all' | 'articles' | 'episodes' | 'questions' | 'thoughts';
type SearchMode = 'hybrid' | 'keyword';
interface SearchFilters { query: string; type: ContentType; includeArchived: boolean; mode: SearchMode; limit: number; cursor?: string }
interface SearchCursor { v: 1; kind: 'content_search'; token: string; filter: string }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uuid(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

function childAnchor(value: unknown): boolean {
  return value === null || object(value)
    && (value.paragraph_index === null || typeof value.paragraph_index === 'number' && Number.isInteger(value.paragraph_index) && value.paragraph_index >= 0)
    && value.segment_number === null
    && (value.position_seconds === null || typeof value.position_seconds === 'number' && Number.isFinite(value.position_seconds) && value.position_seconds >= 0)
    && value.track_version === null;
}

function searchItem(value: unknown): boolean {
  if (!object(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.snippets)) return false;
  if (value.type === 'articles' || value.type === 'episodes') return true;
  if (value.type !== 'questions' && value.type !== 'thoughts') return false;
  // Child IDs remain opaque. Exact details use the separate raw record UUID and parent UUID.
  return value.id.length > 0 && uuid(value.record_id) && uuid(value.episode_id)
    && typeof value.episode_title === 'string' && typeof value.source_version === 'string' && value.source_version.length > 0
    && childAnchor(value.anchor)
    && value.snippets.every(snippet => object(snippet) && typeof snippet.text === 'string'
      && (snippet.field === 'title' || snippet.field === 'body') && childAnchor(snippet.anchor));
}

export function searchFilters(input: { query?: string; type?: string; excludeArchived?: boolean; mode?: string; limit?: string; cursor?: string }): SearchFilters {
  const query = input.query?.trim();
  if (!query || Array.from(query).length > 500) invalid('--query must contain 1–500 characters.');
  const type = input.type ?? 'all';
  if (!['all', 'articles', 'episodes', 'questions', 'thoughts'].includes(type)) invalid('--type must be all, articles, episodes, questions or thoughts.');
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
  if (!value || !Array.isArray(value.items) || !value.items.every(searchItem) || !(value.next_cursor === null || typeof value.next_cursor === 'string' && value.next_cursor.length > 0) || typeof value.has_more !== 'boolean' || value.has_more !== (value.next_cursor !== null) || value.search_mode !== filters.mode || value.consistency !== 'eventual' || !['ready', 'partial'].includes(String(value.indexing_status)) || typeof value.candidate_limit_reached !== 'boolean') throw new CLIError('invalid_response', 'Invalid server content search response.', 1);
  // Preserve source excerpts and anchors; only the opaque continuation receives a local account/API binding.
  return { ...value, next_cursor: value.next_cursor === null ? null : Buffer.from(JSON.stringify({ v: 1, kind: 'content_search', token: value.next_cursor, filter })).toString('base64url') };
}
