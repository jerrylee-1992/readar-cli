import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CLIError, isMissing } from './errors.js';

export interface User { id: string; identities: { provider: string; display: string }[] }
export interface Credentials { access_token: string; refresh_token: string; expires_at: number; user: User }
export interface State { credentials?: Credentials; challenge?: { challenge_id: string; expires_at: number } }
export const configDir = () => process.env.READAR_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'readar');
export async function readJSON<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (e) { if (isMissing(e)) return undefined; throw new CLIError('config_error', 'Cannot read CLI configuration. Check file permissions and JSON format.', 1); }
}
export async function atomicJSON(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function ensureDir(): Promise<void> { await mkdir(configDir(), { recursive: true, mode: 0o700 }); }
export async function savedURL(): Promise<string | undefined> { return (await readJSON<{ api_url: string }>(join(configDir(), 'config.json')))?.api_url; }
export async function saveURL(api_url: string): Promise<void> { await ensureDir(); await atomicJSON(join(configDir(), 'config.json'), { api_url }); }

export class Store {
  readonly file: string;
  constructor(readonly url: string) { this.file = join(configDir(), `session-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.json`); }
  async read(): Promise<State> { return await readJSON<State>(this.file) ?? {}; }
  async write(state: State): Promise<void> { await atomicJSON(this.file, state); await chmod(this.file, 0o600); }
  async locked<T>(action: (state: State) => Promise<T>): Promise<T> {
    await ensureDir();
    const lock = `${this.file}.lock`;
    const start = Date.now();
    while (true) {
      try { await writeFile(lock, JSON.stringify({ pid: process.pid, started_at: Date.now() }), { flag: 'wx', mode: 0o600 }); break; }
      catch (e) {
        if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e;
        if (Date.now() - start > 35_000) throw new CLIError('session_busy', 'Another command holds the session lock. If a command crashed, remove the .lock file in READAR_CONFIG_DIR after confirming no Readar CLI process is running.', 1);
        await delay(50);
      }
    }
    try { return await action(await this.read()); }
    finally { await unlink(lock); }
  }
}
