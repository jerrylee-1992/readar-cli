#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { Client, normalizeURL } from './client.js';
import { CLIError, invalid } from './errors.js';
import { savedURL, saveURL } from './store.js';
import { listRecords, getRecord, dateValue, parseCursor, type Kind } from './records.js';

const HELP = `Readar CLI 0.1.0 — agent-friendly collector and personal history client

Usage:
  readar auth login --email <email> [--api-url <url>]
  readar auth verify --code <code> [--challenge-id <id>]
  readar auth status
  readar auth logout [--local]
  readar collect (--stdin | --file <path> | --text <text> | --url <url>) [--note <text>]
  readar questions list [--query <text>] [--episode <id>] [--since <date>] [--until <date>]
                       [--limit <1..100>] [--cursor <next_cursor>]
  readar questions get <id> [--episode <id>]
  readar notes list [same filters] [--kind thought|question]
  readar notes get <id> [--episode <id>]

Global: --api-url <url>, --help, --version
Environment: READAR_API_URL, READAR_CONFIG_DIR
Default API: https://readar-api.starmind.tech
API precedence: --api-url, READAR_API_URL, saved URL, default API.
After installation, run readar auth login to sign in with email verification.
A successful login remembers the API URL.
JSON results go to stdout. JSON errors and interactive prompts go to stderr.
Dates use UTC; --since is inclusive, --until is exclusive.
Noninteractive auth login sends a code; auth verify completes login.
Questions and notes use global server APIs. Full-text search is eventually consistent.
Exit codes: 0 success, 1 network/config/server, 2 usage/input, 3 login required, 4 not found.
`;
function options(argv: string[]) {
  try { return parseArgs({ args: argv, allowPositionals: true, options: {
    'api-url': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    email: { type: 'string' }, code: { type: 'string' }, 'challenge-id': { type: 'string' }, local: { type: 'boolean' },
    stdin: { type: 'boolean' }, file: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' },
    query: { type: 'string' }, episode: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
    limit: { type: 'string' }, cursor: { type: 'string' }, kind: { type: 'string' },
  } }); } catch { return invalid('Unknown option or missing option value. Run readar --help.'); }
}
async function readText(input: Readable): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of input) { const b = Buffer.from(chunk); bytes += b.length; if (bytes > 4_000_000) invalid('Input exceeds the collector size limit.'); chunks.push(b); }
  return Buffer.concat(chunks).toString('utf8');
}
async function main(): Promise<void> {
  const { values: v, positionals: p } = options(process.argv.slice(2));
  if (v.help || p.length === 0 && !v.version) { process.stdout.write(HELP); return; }
  if (v.version) { process.stdout.write('0.1.0\n'); return; }
  const command = p[0]; const action = p[1];
  const allowed: Record<string, string[]> = {
    'auth login': ['email'], 'auth verify': ['code', 'challenge-id'], 'auth status': [], 'auth logout': ['local'],
    collect: ['stdin', 'file', 'text', 'url', 'note'],
    'questions list': ['query', 'episode', 'since', 'until', 'limit', 'cursor'], 'questions get': ['episode'],
    'notes list': ['query', 'episode', 'since', 'until', 'limit', 'cursor', 'kind'], 'notes get': ['episode'],
  };
  const name = command === 'collect' ? command : `${command} ${action}`;
  if (!allowed[name]) invalid('Unknown command. Run readar --help.');
  for (const k of Object.keys(v)) if (!['api-url', 'help', 'version', ...allowed[name]!].includes(k)) invalid(`--${k} is not valid for ${name}.`);
  const expected = command === 'collect' ? 1 : action === 'get' ? 3 : 2;
  if (p.length !== expected) invalid(`Incorrect arguments for ${name}. Run readar --help.`);
  const limit = v.limit === undefined ? 30 : Number(v.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('--limit must be an integer from 1 to 100.');
  dateValue(v.since, '--since'); dateValue(v.until, '--until'); parseCursor(v.cursor);
  if (v.kind && !['thought', 'question'].includes(v.kind)) invalid('--kind must be thought or question.');
  if (v.episode !== undefined && !v.episode.trim()) invalid('--episode cannot be empty.');
  if (v.code !== undefined && !/^\d{6}$/.test(v.code)) invalid('--code must have six digits.');
  if (command === 'auth' && action === 'verify' && !v.code) invalid('Provide --code <six-digit-code>.');
  if (command === 'auth' && action === 'login' && !v.email && !stdin.isTTY) invalid('Provide --email for noninteractive login.');
  const rawURL = v['api-url'] || process.env.READAR_API_URL || await savedURL() || 'https://readar-api.starmind.tech';
  const apiURL = normalizeURL(rawURL); const client = new Client(apiURL);
  let result: unknown;
  if (command === 'auth') {
    if (action === 'login') {
      let email = v.email;
      const rl = stdin.isTTY ? createInterface({ input: stdin, output: stderr }) : undefined;
      try {
        if (!email) email = await rl!.question('Email: ');
        email = email.trim(); if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Provide a valid email address.');
        result = await client.login(email); await saveURL(apiURL);
        if (rl) { stderr.write('Verification email sent.\n'); const code = await rl.question('Verification code: '); if (!/^\d{6}$/.test(code.trim())) invalid('Verification code must have six digits.'); result = await client.verify(code.trim()); }
      } finally { rl?.close(); }
    } else if (action === 'verify') { result = await client.verify(v.code!, v['challenge-id']); await saveURL(apiURL); }
    else if (action === 'status') result = { authenticated: true, user: await client.request('/v1/me') };
    else result = await client.logout(!!v.local);
  } else if (command === 'collect') {
    const sources = ['stdin', 'file', 'text', 'url'].filter(k => v[k as keyof typeof v] !== undefined && v[k as keyof typeof v] !== false);
    if (sources.length !== 1) invalid('Choose exactly one of --stdin, --file, --text or --url.');
    let text: string | undefined;
    if (v.stdin) { if (stdin.isTTY) invalid('Pipe content into --stdin.'); text = await readText(stdin); }
    if (v.file !== undefined) { try { text = await readText(createReadStream(v.file)); } catch (e) { if (e instanceof CLIError) throw e; throw new CLIError('file_error', 'Cannot read the input file.', 2); } }
    if (v.text !== undefined) text = v.text;
    if (text !== undefined && (!text.trim() || Array.from(text).length > 1_000_000)) invalid('Text must contain 1 to 1,000,000 characters.');
    if (v.note && Array.from(v.note).length > 4000) invalid('--note exceeds 4,000 characters.');
    if (v.url !== undefined) { let u: URL; try { u = new URL(v.url); } catch { return invalid('--url must be an HTTP or HTTPS URL.'); } if (!['http:', 'https:'].includes(u.protocol) || v.url.length > 8192) invalid('Invalid collection URL.'); }
    result = await client.request('/v1/articles', 'POST', { ...(text === undefined ? { url: v.url } : { text }), note: v.note || '' });
  } else {
    const kind = command as Kind;
    result = action === 'list' ? await listRecords(client, kind, { query: v.query, episode: v.episode, since: v.since, until: v.until, kind: v.kind, limit, cursor: v.cursor }) : await getRecord(client, kind, p[2]!, v.episode);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => {
  const e = error instanceof CLIError ? error : new CLIError('internal_error', 'Unexpected CLI failure. Check configuration permissions and retry.', 1);
  process.stderr.write(JSON.stringify({ error: { code: e.code, message: e.message, ...(e.status ? { status: e.status } : {}) } }) + '\n');
  process.exitCode = e.exitCode;
});
