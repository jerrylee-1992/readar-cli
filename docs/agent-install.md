# Install and use Readar CLI as an agent

A user can ask an agent: “Read this installation guide, install Readar CLI, and help me sign in.” Host this file at a stable public URL after choosing the repository and publishing location.

## Before registry publication

This is an unpublished local project. Do not assume `readar-cli` on npm is this project. Obtain the trusted repository URL or local checkout path from the user.

1. Check `node --version`: Node.js 22+ is required. Check `npm --version`. If missing, use the user's established Node installation method or the official Node.js installer for their OS.
2. From the trusted checkout, run `npm ci`, `npm run build`, then `npm install -g .`. If global installation is unavailable, run `node <checkout>/dist/main.js` instead.
3. Verify with `readar --version` and `readar --help`.

## After registry publication

The maintainer must update this guide with the verified package name and released version. Install that exact package with `npm install -g <package>@<version>`, or use `npx -y --package <package>@<version> readar ...` if global installation is unavailable. Do not substitute an unrelated similarly named package.

## Login

1. Obtain the user's Readar API URL and account email. Do not infer which deployment contains the user's data.
2. Run `readar auth status --api-url <url>`. Exit 3 means login is needed.
3. Run `readar auth login --api-url <url> --email <email>` noninteractively. This sends an email and returns a challenge. Never repeat sending in a loop.
4. Ask the user to enter the received code locally with `readar auth verify --api-url <url> --code <code>`, or pass the code to the CLI if the user explicitly supplies it. Codes expire; exit 2 means verification failed. Apple-only users need to bind their email in the App first.
5. Verify with `readar auth status`. Never read, display or copy the session credential files into agent context.

## Usage

- Save generated text: `readar collect --file <file>` or pipe it to `readar collect --stdin`. Prefer a file or stdin for large content and shell-sensitive text.
- Search user questions: `readar questions list --query <text>`.
- Search user notes: `readar notes list --query <text>`.
- Read one result: `readar questions get <id>` or `readar notes get <id>`. Use `--episode <id>` from a previous result to narrow the scope.
- Parse JSON stdout; inspect exit code and JSON stderr. Keep stdout and stderr separate.
- Continue lists using `next_cursor` with the same filters. A null cursor means no further matching records.
- Handle exit 3 by explaining that login is required. Do not loop login or refresh attempts.
- Global searches use the server full-text index with one request per page. Saved or edited content appears asynchronously. On `search_unavailable`, retry later; do not fall back to scanning episodes. Follow `next_cursor` until null, including after an empty page.
