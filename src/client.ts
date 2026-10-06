import { CLIError, invalid, loginRequired } from './errors.js';
import { Store, type Credentials, type State, type User } from './store.js';

export function normalizeURL(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return invalid('Provide a valid API URL with --api-url or READAR_API_URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(local && u.protocol === 'http:')) || u.username || u.password || u.search || u.hash) invalid('API URL must use HTTPS (HTTP is allowed for localhost), without credentials, query or fragment.');
  return u.href.replace(/\/+$/, '');
}
function credentials(value: unknown): Credentials {
  if (!value || typeof value !== 'object') throw new CLIError('invalid_response', 'Invalid authentication response.', 1);
  const v = value as Record<string, unknown>;
  const user = v.user as User | undefined;
  if (typeof v.access_token !== 'string' || !v.access_token.startsWith('ra_') || typeof v.refresh_token !== 'string' || !v.refresh_token.startsWith('rr_') || typeof v.expires_in !== 'number' || !Number.isFinite(v.expires_in) || v.expires_in <= 0 || !user || typeof user.id !== 'string' || !Array.isArray(user.identities)) throw new CLIError('invalid_response', 'Invalid authentication response.', 1);
  return { access_token: v.access_token, refresh_token: v.refresh_token, expires_at: Date.now() + v.expires_in * 1000, user };
}
export class Client {
  readonly store: Store;
  private principal?: string;
  constructor(readonly url: string) { this.store = new Store(url); }
  async raw(path: string, method = 'GET', body?: unknown, token?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.url + path, { method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new CLIError('network_error', 'Cannot reach the Readar API. Check the URL and network connection.', 1); }
    if (response.status === 204) return null;
    let value: unknown;
    try { value = await response.json(); } catch { throw new CLIError('invalid_response', 'API did not return JSON.', 1, response.status); }
    if (!response.ok) {
      const error = (value as { error?: { code?: unknown } } | null)?.error;
      const code = typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'api_error';
      // Keep remote response text out of errors: proxies may echo credentials or request bodies.
      const messages: Record<string, string> = { invalid_code: 'Verification code is incorrect or expired.', rate_limited: 'Too many requests. Try again later.', mail_unavailable: 'Verification email could not be sent.', not_found: 'Record was not found.', unauthorized: 'Session is expired or revoked.', forbidden: 'This account does not have access.', invalid_input: 'The API rejected the submitted input.', invalid_cursor: 'Cursor expired or filters changed. Start a new listing.', search_unavailable: 'Full-text search is unavailable. Try again later.' };
      throw new CLIError(code, messages[code] || `API request failed (HTTP ${response.status}).`, response.status === 401 ? 3 : response.status === 404 ? 4 : response.status >= 500 || response.status === 429 ? 1 : 2, response.status);
    }
    return value;
  }
  private assertAccount(state: State): string {
    if (!state.credentials) loginRequired();
    const id = state.credentials.user.id;
    if (this.principal && this.principal !== id) throw new CLIError('account_changed', 'The signed-in account changed during this command. Start a new command.', 3);
    this.principal = id;
    return id;
  }
  async accountID(): Promise<string> {
    return this.store.locked(async state => this.assertAccount(state));
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    return this.store.locked(state => this.authorized(state, path, method, body));
  }
  private async authorized(state: State, path: string, method: string, body?: unknown): Promise<unknown> {
    this.assertAccount(state);
    if (state.credentials!.expires_at <= Date.now() + 30_000) await this.refresh(state);
    this.assertAccount(state);
    try { return await this.raw(path, method, body, state.credentials!.access_token); }
    catch (e) {
      if (!(e instanceof CLIError && e.status === 401)) throw e;
      await this.refresh(state);
      this.assertAccount(state);
      try { return await this.raw(path, method, body, state.credentials!.access_token); }
      catch (retry) { if (retry instanceof CLIError && retry.status === 401) loginRequired(); throw retry; }
    }
  }
  private async refresh(state: State): Promise<void> {
    if (!state.credentials) loginRequired();
    try {
      state.credentials = credentials(await this.raw('/v1/auth/refresh', 'POST', { refresh_token: state.credentials.refresh_token }));
      await this.store.write(state);
    } catch (e) {
      if (e instanceof CLIError && e.status === 401) { delete state.credentials; await this.store.write(state); loginRequired(); }
      throw e;
    }
  }
  async login(email: string): Promise<unknown> {
    return this.store.locked(async state => {
      const value = await this.raw('/v1/auth/email/codes', 'POST', { email }) as { challenge_id: string; expires_in: number; resend_after: number };
      if (typeof value?.challenge_id !== 'string' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new CLIError('invalid_response', 'Invalid verification challenge.', 1);
      state.challenge = { challenge_id: value.challenge_id, expires_at: Date.now() + value.expires_in * 1000 };
      await this.store.write(state);
      return { ...value, next: 'readar auth verify --code <six-digit-code>' };
    });
  }
  async verify(code: string, challenge?: string): Promise<unknown> {
    return this.store.locked(async state => {
      const id = challenge || state.challenge?.challenge_id;
      if (!id || (!challenge && state.challenge!.expires_at <= Date.now())) invalid('Run auth login to request a new verification code.');
      const next = credentials(await this.raw('/v1/auth/email/verify', 'POST', { challenge_id: id, code }));
      state.credentials = next; delete state.challenge; await this.store.write(state);
      return { authenticated: true, user: next.user };
    });
  }
  async logout(local: boolean): Promise<unknown> {
    return this.store.locked(async state => {
      let revoked = false;
      if (!local && state.credentials) {
        try { await this.authorized(state, '/v1/auth/logout', 'POST'); revoked = true; }
        catch (e) { if (!(e instanceof CLIError && e.code === 'login_required')) throw e; }
      }
      await this.store.write({});
      return { authenticated: false, remote_revoked: revoked };
    });
  }
}
