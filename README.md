# Readar CLI

A standalone TypeScript / Node.js client for agents to save AI output into Readar and query the signed-in user's podcast questions and listening notes.

Requires Node.js 22 or newer. The CLI talks only to the Readar HTTP API. It has no backend, database or AI-provider dependencies.

## One-sentence installation for agents

Tell your agent:

> Please read https://github.com/jerrylee-1992/readar-cli/blob/codex/agent-install/skills/readar/SKILL.md, follow the instructions to install and use Readar CLI.

The [Readar Skill](skills/readar/SKILL.md) covers installation, email login, collection, questions and notes, pagination and error handling. It is self-contained and included in the compiled package. Agents can read it directly; agents with native Skill support can install the `skills/readar` folder using their supported skill installer. Reading the URL alone does not register a skill for future automatic discovery.

With Node.js 22+, npm and Git installed, install into npm's execution cache and run directly from this public repository with one command:

```sh
npx -y --package='git+https://github.com/jerrylee-1992/readar-cli.git#codex/agent-install' readar --help
```

The Git installation builds the executable automatically. No npm registry release, GitHub login or administrator permissions are required. The ref selects the installation-enabled branch; it can be replaced with a reviewed commit SHA for reproducible installs.

Use the same prefix for subsequent commands, for example:

```sh
npx -y --package='git+https://github.com/jerrylee-1992/readar-cli.git#codex/agent-install' readar auth status
```

The agent guide also covers a permanent standalone executable installed from source. Installation does not sign you in; email verification remains a separate step.

## Install from a checkout

```sh
npm ci
npm run build
npm install -g .
readar --help
```

To run without global installation:

```sh
node dist/main.js --help
```

This project has **not** been published to npm. Use the GitHub URL above; do not install a similarly named registry package. `npm pack` builds the compiled package automatically.

## Sign in

On first use, specify your Readar API URL. Use HTTPS; HTTP is accepted only on localhost.

```sh
readar auth login --api-url https://YOUR-READAR-API --email you@example.com
```

In a terminal, this sends the verification email and prompts for the code. In a noninteractive agent process, it returns a JSON challenge without prompting. Complete the login in a second command:

```sh
readar auth verify --code 123456
readar auth status
```

`auth verify --challenge-id <id> --code <code>` also supports an explicitly supplied challenge ID.

The API URL is remembered when a code is sent, and after successful verification. Any command can override it using `--api-url` or `READAR_API_URL`; precedence is flag, environment, saved URL. Always connect to the deployment containing the user's data.

The backend already supports email login and email binding. Users with Apple-only accounts must bind an email in the Readar App first. The CLI does not implement Apple login or App device authorization. The backend's account access policy still applies; using an unbound email may create a different account or be denied by that policy.

Access and refresh tokens are saved in per-API files with permissions `0600` under `${XDG_CONFIG_HOME:-~/.config}/readar`, or `READAR_CONFIG_DIR`. They are never printed. Tokens are automatically refreshed, and concurrent CLI processes share a session lock so a rotating refresh token is used once. The backend currently expires sessions after 30 days; reauthentication may be required sooner if a session is revoked. Login uses an independent session, leaving App sessions intact.

```sh
readar auth logout          # Revoke this session and remove local credentials
readar auth logout --local  # Remove local credentials without contacting the API
```

A failed remote logout keeps credentials so you can retry. If a process is forcibly killed while holding a lock, subsequent commands return `session_busy` after 35 seconds. Confirm no Readar CLI process is running, then remove the corresponding `session-*.json.lock` file from the config directory. Never remove a lock held by a live process.

## Save AI output to the collector

Choose exactly one input method:

```sh
readar collect --file answer.md --note "AI research output"
cat answer.md | readar collect --stdin
readar collect --text "A generated explanation"
readar collect --url https://example.com/article
```

Results include `article.id`, `article.status`, and `created`. Plain text is stored as ready content. URLs use the existing ingestion flow. The backend deduplicates identical trimmed text or canonical URLs for the signed-in user; a duplicate returns the existing article with `created: false`, preserving its existing metadata and archive state. For Markdown, the first line becomes the collector title. Markdown is stored as submitted text; it is not converted to HTML.

## Query questions and notes

```sh
readar questions list --query "asset allocation" --limit 20
readar questions list --episode <episode-id>
readar questions get <question-id>
readar notes list --query "idea" --kind thought --since 2026-10-01
readar notes get <note-id> --episode <episode-id>
```

Question search covers question text, answers and answer summaries; heard-answer text is a subset of the generated answer. Note search covers note text. Search uses the server’s Tablestore full-text index with Chinese tokenization and case-insensitive English matching; it is not semantic search. A query requires matching all analyzed words within at least one searched field. Newly saved or edited content may take seconds to tens of seconds to appear. Notes include both `thought` and `question` kinds unless filtered. Queries use the signed-in user's existing API permissions.

Every returned row includes `episode_id` and `episode_title`. Question responses preserve full answers, status, source article IDs and available listening information. Notes preserve text, position, revision and timestamps.

`--since` is inclusive and `--until` is exclusive. Dates (`YYYY-MM-DD`) mean UTC midnight; timestamps require an explicit timezone. To include the whole day of October 5, use `--until 2026-10-06`.

Lists without `--query` are ordered by creation time descending, then record ID and episode ID descending. Full-text queries are ordered by relevance. Use the returned `next_cursor` unchanged with the same filters and API:

```sh
readar questions list --limit 20 --cursor '<next_cursor>'
```

`--limit` accepts 1–100, default 30. A different limit may be used for the next page. Cursors are bound to the signed-in account; changing accounts invalidates them. An account change during a command aborts with `account_changed` instead of mixing results. For database listings, records created after the previous page's boundary appear in a fresh listing, not subsequent pages.

**Server requirement:** Deploy the Readar global endpoints `GET /v1/questions`, `GET /v1/notes`, and their `/{id}` detail routes. Each CLI listing page makes one authenticated API request, including with `--episode`. There is no episode traversal or automatic scan fallback. `search_mode` is `tablestore` for a full-text query and `server_list` for an unfiltered listing. `consistency` reports `eventual` or `database` respectively.

Search requires server-side configuration and history backfill. An unavailable or unconfigured search index produces `search_unavailable` (exit 1), never an empty successful response. The CLI holds only Readar login credentials; Tablestore credentials stay on the server. Deletions and account ownership are checked against the source database before a candidate is returned, so an index waiting to synchronize cannot expose deleted records. An updated record may temporarily match an old keyword while returning the current source content.

Cursors expire after one hour, are bound to the user, API and filters, and may be reused with a different page limit. Old `client_scan` cursors must be discarded and the listing restarted. Changes during pagination may shift search results; queries are not transactional snapshots. A page can have no items and still carry `next_cursor` when index candidates were deleted, so agents should continue until `next_cursor` is null.

## Agent output contract

Success: one JSON value on stdout. Failure: one JSON object on stderr, with empty stdout. Interactive prompts also go to stderr. `--help` and `--version` return text. Remote error response messages are not echoed, to avoid leaking request data from upstream proxies.

```json
{"error":{"code":"login_required","message":"Run readar auth login to sign in."}}
```

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Network, configuration, server error, rate limit or busy session |
| 2 | Invalid command, input, verification code or API validation failure |
| 3 | Missing, expired or revoked login |
| 4 | Record not found |

API requests time out after 15 seconds and do not follow redirects. Collection and refresh requests are not retried after ambiguous network failures. Collection can be explicitly resubmitted: the backend's content deduplication prevents duplicate entries. A failed refresh after server-side rotation may require login again.

See [agent installation instructions](docs/agent-install.md) for the intended one-sentence onboarding flow.

## Develop and package

```sh
npm ci
npm run check
npm test
npm pack
```

The tests execute the built CLI as independent processes against a real loopback HTTP server. They cover the existing API contract, pagination, filtering, authentication, refresh rotation, concurrent processes, input validation and credential redaction. They do not prove production mail delivery or a production account login.

The package includes compiled JavaScript and documentation. TypeScript and Node type definitions are development-only dependencies. `npm pack` builds automatically; registry publishing is a separate maintainer action.
