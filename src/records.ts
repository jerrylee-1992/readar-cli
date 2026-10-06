import { createHash } from 'node:crypto';
import { Client } from './client.js';
import { CLIError, invalid } from './errors.js';

export type Kind = 'questions' | 'notes';
export interface Filters { query?: string; episode?: string; since?: string; until?: string; kind?: string; limit: number; cursor?: string }
function fingerprint(client: Client, userID: string, kind: Kind, f: Filters): string {
  return createHash('sha256').update(JSON.stringify([client.url, userID, kind, f.query?.trim() ?? '', f.episode ?? '', f.since ?? '', f.until ?? '', f.kind ?? ''])).digest('hex');
}
export function parseCursor(cursor: string | undefined): { v: number; token: string; filter: string } | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value.v !== 2 || typeof value.token !== 'string' || !value.token || typeof value.filter !== 'string') throw new Error();
    return value;
  } catch { return invalid('Invalid or legacy cursor. Start a new listing and use its next_cursor.'); }
}
export function dateValue(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) invalid(`${name} must be YYYY-MM-DD or an ISO timestamp with a timezone.`);
  const calendar = value.slice(0, 10);
  const day = Date.parse(calendar);
  const number = Date.parse(value);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== calendar || !Number.isFinite(number)) invalid(`Invalid ${name}.`);
  return number;
}
export async function listRecords(client: Client, kind: Kind, f: Filters): Promise<unknown> {
  const cursor = parseCursor(f.cursor);
  const filter = fingerprint(client, await client.accountID(), kind, f);
  if (cursor && cursor.filter !== filter) invalid('Cursor belongs to different filters, account or API.');
  const since = dateValue(f.since, '--since'); const until = dateValue(f.until, '--until');
  if (since !== undefined && until !== undefined && since >= until) invalid('--since must be before --until.');
  if (f.query !== undefined && (!f.query.trim() || f.query.trim().length > 500)) invalid('--query must contain 1–500 characters.');
  const params = new URLSearchParams({ limit: String(f.limit) });
  for (const [name, value] of Object.entries({ q: f.query?.trim(), episode: f.episode, kind: f.kind, since: f.since, until: f.until, cursor: cursor?.token })) if (value !== undefined) params.set(name, value);
  const value = await client.request(`/v1/${kind}?${params}`) as { items?: unknown; next_cursor?: unknown; search_mode?: unknown; consistency?: unknown } | null;
  if (!value || !Array.isArray(value.items) || !value.items.every(r => r && typeof r === 'object' && typeof r.id === 'string') || !(value.next_cursor === null || typeof value.next_cursor === 'string') || !['tablestore', 'server_list'].includes(String(value.search_mode))) throw new CLIError('invalid_response', 'Invalid server record listing.', 1);
  return { ...value, next_cursor: value.next_cursor === null ? null : Buffer.from(JSON.stringify({ v: 2, token: value.next_cursor, filter })).toString('base64url') };
}
export async function getRecord(client: Client, kind: Kind, id: string, episode?: string): Promise<unknown> {
  return client.request(`/v1/${kind}/${encodeURIComponent(id)}` + (episode ? '?episode=' + encodeURIComponent(episode) : ''));
}
