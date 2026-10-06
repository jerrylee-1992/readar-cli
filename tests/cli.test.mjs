import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server, url, dir, requests, refreshes, expire, denyRefresh, mode;
const user = { id: 'user-1', identities: [{ provider: 'email', display: 'test@example.com' }] };
before(async () => {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : null;
    const path = new URL(req.url, 'http://localhost');
    requests.push({ path: req.url, body, auth: req.headers.authorization });
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path.pathname === '/v1/auth/email/codes') return send({ challenge_id: 'challenge-1', expires_in: 600, resend_after: 60 });
    if (path.pathname === '/v1/auth/email/verify') {
      if (body.code !== '123456') return send({ error: { code: 'invalid_code', message: 'Wrong code' } }, 400);
      return send({ access_token: 'ra_initial', refresh_token: 'rr_initial', expires_in: 900, user });
    }
    if (path.pathname === '/v1/auth/refresh') {
      refreshes++;
      if (denyRefresh || body.refresh_token !== 'rr_initial') return send({ error: { code: 'unauthorized', message: 'Expired' } }, 401);
      await new Promise(r => setTimeout(r, 80));
      return send({ access_token: 'ra_new', refresh_token: 'rr_new', expires_in: 900, user });
    }
    if (!req.headers.authorization || (expire && req.headers.authorization === 'Bearer ra_initial')) return send({ error: { code: 'unauthorized', message: 'Please log in' } }, 401);
    if (path.pathname === '/v1/me') {
      if (mode === 'redirect') { res.writeHead(302, { location: '/leaked' }); return res.end(); }
      if (mode === 'html') { res.writeHead(502); return res.end('<html>ra_initial rr_initial</html>'); }
      if (mode === 'error') return send({ error: { code: 'internal', message: 'ra_initial rr_initial' } }, 500);
      return send(user);
    }
    if (path.pathname === '/v1/auth/logout') { res.writeHead(204); return res.end(); }
    if (path.pathname === '/v1/articles') return send({ article: { id: 'article-1', ...body, status: 'ready' }, created: true });
    if (/^\/v1\/(notes|questions)(\/|$)/.test(path.pathname)) {
      const kind = path.pathname.split('/')[2];
      let rows = kind === 'notes' ? [
        { id: 'n-2', episode_id: 'ep-2', episode_title: 'Second', kind: 'thought', text: '配置资产', created_at: '2026-10-04T09:00:00Z', revision: 1 },
        { id: 'n-1', episode_id: 'ep-1', episode_title: 'First', kind: 'question', text: '其他内容', created_at: '2026-10-03T09:00:00Z', revision: 1 }
      ] : ['2', '1'].map(n => ({ id: 'q-' + n, episode_id: 'ep-' + n, episode_title: n === '2' ? 'Second' : 'First', question: '资产?', answer: '分散配置', status: 'ready', created_at: '2026-10-04T09:00:00Z' }));
      const f = path.searchParams;
      if (f.get('episode')) rows = rows.filter(r => r.episode_id === f.get('episode'));
      if (path.pathname.split('/').length === 4) {
        const row = rows.find(r => r.id === path.pathname.split('/')[3]);
        return row ? send(row) : send({ error: { code: 'not_found' } }, 404);
      }
      if (mode === 'search-down' && f.has('q')) return send({ error: { code: 'search_unavailable', message: 'private upstream detail' } }, 503);
      if (f.has('q')) rows = rows.filter(r => ['question', 'answer', 'text'].some(k => String(r[k] || '').includes(f.get('q'))));
      if (f.get('kind')) rows = rows.filter(r => r.kind === f.get('kind'));
      if (f.get('since')) rows = rows.filter(r => Date.parse(r.created_at) >= Date.parse(f.get('since')));
      if (f.get('until')) rows = rows.filter(r => Date.parse(r.created_at) < Date.parse(f.get('until')));
      const start = Number(f.get('cursor') || 0), limit = Number(f.get('limit') || 30);
      return send({ items: rows.slice(start, start + limit), next_cursor: rows.length > start + limit ? String(start + limit) : null, search_mode: f.has('q') ? 'tablestore' : 'server_list', consistency: f.has('q') ? 'eventual' : 'database' });
    }
    if (path.pathname === '/v1/episodes') return path.searchParams.get('before') === 'ep-1'
      ? send({ items: [{ id: 'ep-2', title: 'Second' }], next_cursor: null })
      : send({ items: [{ id: 'ep-1', title: 'First' }], next_cursor: 'ep-1' });
    if (path.pathname.endsWith('/notes')) return send({ items: path.pathname.includes('ep-2')
      ? [{ id: 'n-2', kind: 'thought', text: '配置资产', created_at: '2026-10-04T09:00:00Z', revision: 1 }]
      : [{ id: 'n-1', kind: 'question', text: '其他内容', created_at: '2026-10-03T09:00:00Z', revision: 1 }] });
    if (path.pathname.endsWith('/discussion')) return send({ items: [{ id: 'q-' + (path.pathname.includes('ep-2') ? '2' : '1'), question: '资产?', answer: '分散配置', status: 'ready', created_at: '2026-10-04T09:00:00Z' }] });
    return send({ error: { code: 'not_found', message: 'Missing' } }, 404);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); });
beforeEach(async t => {
  dir = await mkdtemp(join(tmpdir(), 'readar-cli-test-'));
  requests = []; refreshes = 0; expire = false; denyRefresh = false; mode = '';
  t.after(() => rm(dir, { recursive: true, force: true }));
});
function run(args, input = '', env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dist/main.js', ...args], { env: { ...process.env, READAR_CONFIG_DIR: dir, READAR_API_URL: url, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('close', code => resolve({ code, out, err })); child.stdin.end(input);
  });
}
async function login() {
  const sent = await run(['auth', 'login', '--email', 'test@example.com']);
  assert.equal(sent.code, 0, sent.err); assert.equal(JSON.parse(sent.out).challenge_id, 'challenge-1');
  const verified = await run(['auth', 'verify', '--code', '123456']);
  assert.equal(verified.code, 0, verified.err); assert.equal(JSON.parse(verified.out).user.id, 'user-1');
  assert.ok(!verified.out.includes('ra_initial')); assert.ok(!verified.out.includes('rr_initial'));
}

test('help works without configuring an API', async () => { const r = await run(['--help'], '', { READAR_API_URL: '' }); assert.equal(r.code, 0); assert.match(r.out, /collect/); });
test('noninteractive login requires an email instead of hanging', async () => { const r = await run(['auth', 'login']); assert.equal(r.code, 2); assert.equal(JSON.parse(r.err).error.code, 'invalid_input'); });
test('login persists restricted credentials and status omits tokens', async () => {
  await login(); const r = await run(['auth', 'status']); assert.equal(r.code, 0); assert.equal(JSON.parse(r.out).user.id, 'user-1'); assert.ok(!r.out.includes('ra_'));
  const files = await readdir(dir); const session = files.find(f => f.endsWith('.json') && f !== 'config.json'); assert.ok(session);
  assert.equal((await stat(join(dir, session))).mode & 0o777, 0o600);
});
test('wrong verification code preserves the pending login for retry', async () => {
  await run(['auth', 'login', '--email', 'test@example.com']); const r = await run(['auth', 'verify', '--code', '000000']); assert.equal(r.code, 2); assert.equal(JSON.parse(r.err).error.code, 'invalid_code');
  assert.equal((await run(['auth', 'verify', '--code', '123456'])).code, 0);
});
test('collect stdin preserves unicode and metadata', async () => {
  await login(); const r = await run(['collect', '--stdin', '--note', 'AI输出'], '# 分析\n正文内容'); assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).article.text, '# 分析\n正文内容'); assert.equal(JSON.parse(r.out).article.note, 'AI输出');
});
test('collect reads file and returns the collector ID', async () => {
  await login(); const file = join(dir, 'answer.md'); await writeFile(file, '文件正文'); const r = await run(['collect', '--file', file]); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).article.id, 'article-1');
});
test('empty input and conflicting input flags do not submit', async () => {
  await login(); for (const args of [['collect', '--stdin'], ['collect', '--stdin', '--text', 'x']]) { const r = await run(args); assert.equal(r.code, 2); }
  assert.equal(requests.filter(r => r.path === '/v1/articles').length, 0);
});
test('unauthenticated query gives a stable authentication error', async () => { const r = await run(['notes', 'list']); assert.equal(r.code, 3); assert.equal(JSON.parse(r.err).error.code, 'login_required'); });
test('questions searches answers through the global server endpoint', async () => {
  await login(); const r = await run(['questions', 'list', '--query', '分散']); assert.equal(r.code, 0, r.err); const data = JSON.parse(r.out); assert.equal(data.items.length, 2); assert.equal(data.items[0].episode_id, 'ep-2');
  assert.ok(requests.some(r => r.path.startsWith('/v1/questions?')));
  assert.ok(!requests.some(r => r.path.startsWith('/v1/episodes')));
});
test('notes filters dates and kind and pages results', async () => {
  await login(); const r = await run(['notes', 'list', '--since', '2026-10-04', '--kind', 'thought', '--limit', '1']); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).items[0].id, 'n-2');
});
test('a cursor continues filtered results without skipping records', async () => {
  await login(); const first = JSON.parse((await run(['questions', 'list', '--limit', '1'])).out); assert.ok(first.next_cursor);
  const r = await run(['questions', 'list', '--limit', '1', '--cursor', first.next_cursor]); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).items[0].id, 'q-1'); assert.equal(JSON.parse(r.out).next_cursor, null);
});
test('get finds a note globally with episode context', async () => { await login(); const r = await run(['notes', 'get', 'n-2']); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).episode_title, 'Second'); });
test('unknown ID returns not_found', async () => { await login(); const r = await run(['questions', 'get', 'missing']); assert.equal(r.code, 4); assert.equal(JSON.parse(r.err).error.code, 'not_found'); });
test('expired access is refreshed once and credentials survive subsequent commands', async () => {
  await login(); expire = true; const r = await run(['auth', 'status']); assert.equal(r.code, 0, r.err); assert.equal(refreshes, 1); assert.equal((await run(['auth', 'status'])).code, 0); assert.equal(refreshes, 1);
});
test('parallel processes serialize refresh token rotation', async () => {
  await login(); expire = true; const all = await Promise.all(Array.from({ length: 4 }, () => run(['auth', 'status']))); all.forEach(r => assert.equal(r.code, 0, r.err)); assert.equal(refreshes, 1);
});
test('refresh rejection returns login_required without leaking credentials', async () => {
  await login(); expire = true; denyRefresh = true; const r = await run(['auth', 'status']); assert.equal(r.code, 3); assert.equal(JSON.parse(r.err).error.code, 'login_required'); assert.ok(!r.err.includes('rr_initial'));
});
test('different API origins never reuse saved credentials', async () => { await login(); const r = await run(['auth', 'status', '--api-url', url + '/other']); assert.equal(r.code, 3); });
test('logout revokes remote session and clears local credentials', async () => {
  await login(); const r = await run(['auth', 'logout']); assert.equal(r.code, 0, r.err); assert.ok(requests.some(r => r.path === '/v1/auth/logout')); assert.equal((await run(['notes', 'list'])).code, 3);
});
test('invalid flags, limits, dates and cursors return usage errors', async () => {
  for (const args of [['notes', 'list', '--limit', '0'], ['notes', 'list', '--since', 'yesterday'], ['notes', 'list', '--cursor', 'oops'], ['collect', '--unknown'], ['notes', 'get'], ['notes', 'list', '--kind', 'other']]) { const r = await run(args); assert.equal(r.code, 2, r.err); }
});

test('invalid calendar dates are rejected before accessing the API', async () => {
  for (const date of ['2026-02-30', '2026-02-30T12:00:00Z']) { const r = await run(['notes', 'list', '--since', date]); assert.equal(r.code, 2, r.err); assert.equal(JSON.parse(r.err).error.code, 'invalid_input'); }
  assert.equal(requests.length, 0);
});
test('cursor cannot be reused with different filters', async () => {
  await login(); const first = JSON.parse((await run(['questions', 'list', '--limit', '1'])).out);
  const r = await run(['questions', 'list', '--query', 'different', '--cursor', first.next_cursor]); assert.equal(r.code, 2);
});
test('episode filter avoids scanning all episodes', async () => {
  await login(); const r = await run(['questions', 'list', '--episode', 'ep-1']); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).items.length, 1);
  assert.equal(requests.filter(r => r.path.startsWith('/v1/episodes?')).length, 0);
});
test('unsafe API URLs reject before credentials are sent', async () => {
  for (const api of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?token=secret', 'https://example.com#fragment']) { const r = await run(['auth', 'status', '--api-url', api]); assert.equal(r.code, 2); }
  assert.equal(requests.length, 0);
});
test('API redirect never forwards credentials', async () => {
  await login(); mode = 'redirect'; const r = await run(['auth', 'status']); assert.equal(r.code, 1); assert.equal(JSON.parse(r.err).error.code, 'network_error'); assert.ok(!requests.some(r => r.path === '/leaked'));
});
test('proxy HTML and server errors never expose credentials', async () => {
  await login(); for (const scenario of ['html', 'error']) { mode = scenario; const r = await run(['auth', 'status']); assert.equal(r.code, 1); assert.ok(!r.err.includes('ra_initial')); assert.ok(!r.err.includes('rr_initial')); }
});
test('local logout clears credentials without contacting the server', async () => {
  await login(); requests = []; const r = await run(['auth', 'logout', '--local']); assert.equal(r.code, 0); assert.equal(JSON.parse(r.out).remote_revoked, false); assert.equal(requests.length, 0);
});
test('successful login remembers the API for later commands', async () => {
  await login(); const r = await run(['auth', 'status'], '', { READAR_API_URL: '' }); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).authenticated, true);
});
test('collection URL passes through to the API', async () => {
  await login(); const r = await run(['collect', '--url', 'https://example.com/article']); assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).article.url, 'https://example.com/article');
});

test('logout holds one transaction so login at its boundary survives', async () => {
  await login();
  const { Client } = await import('../dist/client.js');
  const oldDir = process.env.READAR_CONFIG_DIR; process.env.READAR_CONFIG_DIR = dir;
  try {
    const client = new Client(url);
    const locked = client.store.locked.bind(client.store);
    let first = true;
    client.store.locked = async action => {
      const inject = first; first = false;
      const result = await locked(action);
      if (inject) await client.verify('123456', 'new-challenge');
      return result;
    };
    await client.logout(false);
    assert.ok((await client.store.read()).credentials, 'Logout erased the newly completed login');
  } finally { if (oldDir === undefined) delete process.env.READAR_CONFIG_DIR; else process.env.READAR_CONFIG_DIR = oldDir; }
});

test('a cursor is rejected after signing in as a different user', async () => {
  await login(); const first = JSON.parse((await run(['questions', 'list', '--limit', '1'])).out);
  const file = (await readdir(dir)).find(f => f.startsWith('session-') && f.endsWith('.json'));
  const state = JSON.parse(await readFile(join(dir, file), 'utf8')); state.credentials.user.id = 'other-user';
  await writeFile(join(dir, file), JSON.stringify(state));
  const r = await run(['questions', 'list', '--cursor', first.next_cursor]); assert.equal(r.code, 2, r.err); assert.equal(JSON.parse(r.err).error.code, 'invalid_input');
});

test('an account switch between query requests aborts instead of mixing accounts', async () => {
  await login(); const { Client } = await import('../dist/client.js');
  const oldDir = process.env.READAR_CONFIG_DIR; process.env.READAR_CONFIG_DIR = dir;
  try {
    const client = new Client(url);
    await client.request('/v1/me');
    await client.store.locked(async state => { state.credentials.user.id = 'other-user'; await client.store.write(state); });
    await assert.rejects(client.request('/v1/episodes?limit=100'), e => e.code === 'account_changed');
  } finally { if (oldDir === undefined) delete process.env.READAR_CONFIG_DIR; else process.env.READAR_CONFIG_DIR = oldDir; }
});

test('oversized file is rejected without submitting content', async () => {
  await login(); const file = join(dir, 'large.txt'); await writeFile(file, Buffer.alloc(4_000_001, 97));
  const r = await run(['collect', '--file', file]); assert.equal(r.code, 2); assert.equal(JSON.parse(r.err).error.code, 'invalid_input');
  assert.ok(!requests.some(r => r.path === '/v1/articles'));
});

test('global full text query uses one server request without scanning episodes', async () => {
  await login(); requests = [];
  const result = await run(['notes', 'list', '--query', '资产', '--limit', '10']);
  assert.equal(result.code, 0, result.err);
  const paths = requests.map(r => r.path);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].startsWith('/v1/notes?'));
  assert.equal(JSON.parse(result.out).search_mode, 'tablestore');
});

test('server search outage returns error instead of falling back to scans', async () => {
  await login(); requests = []; mode = 'search-down';
  const result = await run(['notes', 'list', '--query', '资产']);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.equal(JSON.parse(result.err).error.code, 'search_unavailable');
  assert.equal(requests.length, 1);
});
