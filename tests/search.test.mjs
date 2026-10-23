import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server, url, dir, requests, scenario, account;
const serverCursor = 'signed:opaque/+?=token';
const article = {
  id: 'article-1', type: 'articles', title: '让 AI 操作软件', created_at: '2026-10-23T01:00:00+00:00',
  archived: true, source_version: 'article-sha256',
  snippets: [{ text: '原文：智能体可以调用工具。', field: 'body', anchor: { paragraph_index: 3, segment_number: null, position_seconds: null, track_version: null } }],
  anchor: { paragraph_index: 3, segment_number: null, position_seconds: null, track_version: null },
};
const episode = {
  id: 'episode-1', type: 'episodes', title: '从阅读到记忆', created_at: '2026-10-22T01:00:00+00:00',
  archived: false, source_version: 'episode-sha256',
  snippets: [{ text: '讲稿原文：复述有助于记忆。', field: 'body', anchor: { paragraph_index: null, segment_number: 7, position_seconds: 92.5, track_version: 'track-2' } }],
  anchor: { paragraph_index: null, segment_number: 7, position_seconds: 92.5, track_version: 'track-2' },
};

before(async () => {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : null;
    const path = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const route = path.pathname.replace(/^\/other(?=\/)/, '');
    if (route === '/v1/auth/email/codes') return send({ challenge_id: 'search-challenge', expires_in: 600, resend_after: 60 });
    if (route === '/v1/auth/email/verify') return send({ access_token: 'ra_search', refresh_token: 'rr_search', expires_in: 900, user: { id: account, identities: [] } });
    if (!req.headers.authorization) return send({ error: { code: 'unauthorized' } }, 401);
    if (route !== '/v1/search') return send({ error: { code: 'not_found' } }, 404);
    if (scenario === 'unavailable') return send({ error: { code: 'search_unavailable', message: 'ra_search rr_search provider secret' } }, 503);
    if (scenario === 'expired') return send({ error: { code: 'search_expired' } }, 410);
    if (scenario === 'invalid-cursor') return send({ error: { code: 'invalid_cursor' } }, 422);
    const next = path.searchParams.has('cursor');
    const result = {
      items: next ? [episode] : [article], next_cursor: next ? null : serverCursor, has_more: !next,
      search_mode: path.searchParams.get('mode'), consistency: 'eventual', indexing_status: 'ready', candidate_limit_reached: next,
    };
    if (scenario === 'empty') { result.items = []; result.indexing_status = 'partial'; }
    if (scenario === 'downgraded') result.search_mode = 'keyword';
    if (scenario === 'malformed') delete result.candidate_limit_reached;
    if (scenario === 'unknown-index-status') result.indexing_status = 'unavailable';
    if (scenario === 'inconsistent-pagination') result.has_more = false;
    if (scenario === 'title-only') result.items = [{ ...article, snippets: [{ text: article.title, field: 'title', anchor: null }], anchor: null }];
    return send(result);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); });
beforeEach(async t => {
  dir = await mkdtemp(join(tmpdir(), 'readar-search-test-'));
  requests = []; scenario = ''; account = 'search-user-1';
  t.after(() => rm(dir, { recursive: true, force: true }));
});
function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dist/main.js', ...args], { env: { ...process.env, READAR_CONFIG_DIR: dir, READAR_API_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('close', code => resolve({ code, out, err })); child.stdin.end();
  });
}
async function login(api) {
  const extra = api ? ['--api-url', api] : [];
  for (const args of [['auth', 'login', '--email', 'test@example.com'], ['auth', 'verify', '--code', '123456']]) {
    const result = await run([...args, ...extra]); assert.equal(result.code, 0, result.err);
  }
  requests = [];
}
function page(result) { assert.equal(result.code, 0, result.err); assert.equal(result.err, ''); return JSON.parse(result.out); }

test('content search defaults to one authenticated hybrid request and preserves source evidence', async () => {
  await login();
  const result = page(await run(['search', '--query', '  让 AI 帮我操作软件  ']));
  assert.deepEqual(requests, [{ method: 'GET', path: '/v1/search?q=%E8%AE%A9+AI+%E5%B8%AE%E6%88%91%E6%93%8D%E4%BD%9C%E8%BD%AF%E4%BB%B6&type=all&include_archived=true&mode=hybrid&limit=20', auth: 'Bearer ra_search' }]);
  assert.deepEqual(result.items, [article]);
  assert.equal(result.search_mode, 'hybrid'); assert.equal(result.consistency, 'eventual');
  assert.equal(result.indexing_status, 'ready'); assert.equal(result.candidate_limit_reached, false);
  assert.equal(result.has_more, true); assert.ok(result.next_cursor);
});

test('content scope, archive exclusion, explicit keyword mode and page size reach the API', async () => {
  await login();
  for (const type of ['articles', 'episodes']) {
    page(await run(['search', '--query', 'browser agents', '--type', type, '--exclude-archived', '--mode', 'keyword', '--limit', '50']));
    const request = new URL(requests.at(-1).path, url);
    assert.equal(request.pathname, '/v1/search');
    assert.deepEqual(Object.fromEntries(request.searchParams), { q: 'browser agents', type, include_archived: 'false', mode: 'keyword', limit: '50' });
  }
});

test('search continues an opaque server cursor and preserves podcast anchors and candidate cap', async () => {
  await login();
  const first = page(await run(['search', '--query', 'memory', '--limit', '1']));
  requests = [];
  const second = page(await run(['search', '--query', 'memory', '--limit', '2', '--cursor', first.next_cursor]));
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].path, url).searchParams.get('cursor'), serverCursor);
  assert.deepEqual(second.items, [episode]); assert.equal(second.next_cursor, null);
  assert.equal(second.has_more, false); assert.equal(second.candidate_limit_reached, true);
});

test('an empty partial page retains its continuation instead of becoming an exhausted search', async () => {
  await login(); scenario = 'empty';
  const first = page(await run(['search', '--query', 'memory']));
  assert.deepEqual(first.items, []); assert.equal(first.indexing_status, 'partial');
  assert.equal(first.has_more, true); assert.ok(first.next_cursor);
  scenario = '';
  const second = page(await run(['search', '--query', 'memory', '--cursor', first.next_cursor]));
  assert.equal(second.items[0].id, 'episode-1');
});

test('a title-only search hit retains null anchors without inventing paragraph or playback positions', async () => {
  await login(); scenario = 'title-only';
  const result = page(await run(['search', '--query', 'AI', '--type', 'all']));
  assert.equal(result.items[0].anchor, null);
  assert.deepEqual(result.items[0].snippets, [{ text: '让 AI 操作软件', field: 'title', anchor: null }]);
});

test('search rejects missing queries, field selectors and invalid options before any HTTP request', async () => {
  for (const args of [
    ['search'], ['search', '--query', ' '], ['search', '--query', 'a'.repeat(501)],
    ['search', '--query', 'x', '--type', 'questions'], ['search', '--query', 'x', '--mode', 'semantic'],
    ['search', '--query', 'x', '--fields', 'title'], ['search', '--query', 'x', '--episode', 'ep-1'],
    ['search', '--query', 'x', '--limit', '0'], ['search', '--query', 'x', '--limit', '51'],
    ['search', '--query', 'x', '--limit', '1.5'], ['search', 'extra', '--query', 'x'],
  ]) {
    const result = await run(args); assert.equal(result.code, 2, `${args}: ${result.err}`);
    assert.equal(result.out, ''); assert.equal(JSON.parse(result.err).error.code, 'invalid_input');
  }
  assert.deepEqual(requests, []);
});

test('a 500 character Unicode semantic query is accepted without truncation', async () => {
  await login(); const query = '🧠'.repeat(500);
  page(await run(['search', '--query', query]));
  assert.equal(new URL(requests[0].path, url).searchParams.get('q'), query);
});

test('content search requires login and keeps stdout empty on authentication errors', async () => {
  const result = await run(['search', '--query', 'memory']);
  assert.equal(result.code, 3); assert.equal(result.out, '');
  assert.equal(JSON.parse(result.err).error.code, 'login_required'); assert.deepEqual(requests, []);
});

test('search cursors reject changed query, scope, archive or mode without sending a request', async () => {
  await login(); const first = page(await run(['search', '--query', 'memory']));
  requests = [];
  for (const filters of [['--query', 'other'], ['--query', 'memory', '--type', 'articles'], ['--query', 'memory', '--exclude-archived'], ['--query', 'memory', '--mode', 'keyword']]) {
    const result = await run(['search', ...filters, '--cursor', first.next_cursor]);
    assert.equal(result.code, 2, result.err); assert.equal(JSON.parse(result.err).error.code, 'invalid_input');
  }
  assert.deepEqual(requests, []);
});

test('search cursors reject another account and another API', async () => {
  await login(); const first = page(await run(['search', '--query', 'memory']));
  account = 'search-user-2'; await login();
  const otherAccount = await run(['search', '--query', 'memory', '--cursor', first.next_cursor]);
  assert.equal(otherAccount.code, 2, otherAccount.err); assert.deepEqual(requests, []);
  account = 'search-user-1'; await login(url + '/other');
  const otherAPI = await run(['search', '--query', 'memory', '--cursor', first.next_cursor, '--api-url', url + '/other']);
  assert.equal(otherAPI.code, 2, otherAPI.err); assert.deepEqual(requests, []);
});

test('search rejects record-list and malformed cursors before accessing the API', async () => {
  await login();
  const recordCursor = Buffer.from(JSON.stringify({ v: 2, token: 'old', filter: 'old-filter' })).toString('base64url');
  for (const cursor of ['oops', recordCursor, '', 'x'.repeat(24001)]) {
    const result = await run(['search', '--query', 'memory', '--cursor', cursor]);
    assert.equal(result.code, 2, result.err); assert.equal(JSON.parse(result.err).error.code, 'invalid_input');
  }
  assert.deepEqual(requests, []);
});

test('backend unavailable, expired and invalid cursors remain explicit JSON failures with no fallback', async () => {
  await login();
  for (const [state, code, exit, status] of [['unavailable', 'search_unavailable', 1, 503], ['expired', 'search_expired', 2, 410], ['invalid-cursor', 'invalid_cursor', 2, 422]]) {
    scenario = state; requests = [];
    const result = await run(['search', '--query', 'memory']);
    assert.equal(result.code, exit); assert.equal(result.out, '');
    const error = JSON.parse(result.err).error; assert.equal(error.code, code); assert.equal(error.status, status);
    if (state === 'expired') assert.match(error.message, /search again|new search/i);
    assert.ok(!result.err.includes('ra_search')); assert.ok(!result.err.includes('provider secret'));
    assert.equal(requests.length, 1); assert.equal(new URL(requests[0].path, url).pathname, '/v1/search');
  }
});

test('hybrid search rejects silent keyword downgrade and malformed response metadata', async () => {
  await login();
  for (const state of ['downgraded', 'malformed', 'unknown-index-status', 'inconsistent-pagination']) {
    scenario = state;
    const result = await run(['search', '--query', 'memory']);
    assert.equal(result.code, 1); assert.equal(result.out, '');
    assert.equal(JSON.parse(result.err).error.code, 'invalid_response');
  }
});
