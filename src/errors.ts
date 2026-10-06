export class CLIError extends Error {
  constructor(public code: string, message: string, public exitCode = 2, public status?: number) {
    super(message);
  }
}
export function invalid(message: string): never { throw new CLIError('invalid_input', message); }
export function loginRequired(): never {
  throw new CLIError('login_required', 'Run readar auth login to sign in.', 3);
}
export function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
