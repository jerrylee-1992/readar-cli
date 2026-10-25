# Install and use Readar CLI as an agent

A user can ask an agent:

> 请读取 https://github.com/jerrylee-1992/readar-cli/blob/codex/agent-install/skills/readar/SKILL.md ，安装 CLI 并引导我登录 Readar。

The [Readar Skill](https://github.com/jerrylee-1992/readar-cli/blob/codex/agent-install/skills/readar/SKILL.md) is the entrypoint for install-and-use requests. This guide supplies detailed installation alternatives; native Skill registration uses the agent's supported installer.

## Install from GitHub

The official public repository is https://github.com/jerrylee-1992/readar-cli. This project is not published to npm; do not install a similarly named registry package. Use the installation-enabled `codex/agent-install` ref below, or an explicitly supplied reviewed commit SHA.

1. Check `node --version`, `npm --version` and `git --version`: Node.js 22+ is required. If missing, use the user's established installation method or the official installer for their OS. One sentence to the agent starts the whole workflow; it does not remove these runtime requirements.
2. Install from the public Git URL into npm's execution cache and verify both commands below. npm installs build dependencies and runs `prepare` to compile the executable. No manual cloning, building, global write permission or GitHub login is required:

   ```sh
   npx -y --package='git+https://github.com/jerrylee-1992/readar-cli.git#codex/agent-install' readar --version
   npx -y --package='git+https://github.com/jerrylee-1992/readar-cli.git#codex/agent-install' readar --help
   ```

3. Report the version and the exact `npx ... readar` prefix for subsequent commands. Cached execution does not add a bare `readar` command to the shell's PATH. Do not report success just because npm exits successfully.
4. Continue with the login steps below: check the account status, then guide email verification if login is needed. Use the same command prefix for every step.

### Permanent executable from source

If the user requests a permanent bare `readar` command, clone the installation-enabled branch into an unused directory, then build and install the compiled tarball:

```sh
git clone --branch codex/agent-install --single-branch https://github.com/jerrylee-1992/readar-cli.git readar-cli
cd readar-cli
npm ci
npm pack
npm install -g ./readar-cli-0.1.0.tgz
readar --version
readar --help
```

Install the tarball rather than using `npm install -g <git-url>`: some npm versions propagate global configuration into the Git build and fail to install build dependencies. If the global prefix is not writable, do not request sudo. Keep the checkout under an unused directory in the user's home and verify `node <checkout>/dist/main.js --version` and `--help`; use that full command prefix thereafter. Do not overwrite an existing checkout or change shell profiles without the user's request. On macOS/Linux, a global executable lives in `npm prefix -g` plus `/bin`; on Windows it lives in the prefix itself.

Keep npm lifecycle scripts enabled for this Git package; `--ignore-scripts` prevents compilation. If the environment blocks lifecycle scripts, report that constraint instead of bypassing its policy.

Network failures should be reported without repeatedly reinstalling. Installation itself does not send email or create a login session. After installation, guide the user to sign in; send a verification email only after they supply their account email for login. If they decline, leave the login command without sending email.

## After registry publication

The maintainer must update this guide with the verified package name and released version. Install that exact package with `npm install -g <package>@<version>`, or use `npx -y --package <package>@<version> readar ...` if global installation is unavailable. Do not substitute an unrelated similarly named package.

## Login

1. Use the default API `https://readar-api.starmind.tech` without asking for an address. The CLI preserves overrides: `--api-url`, `READAR_API_URL`, then saved URL, before the default. If the user requests another deployment, keep `--api-url <url>` on every login and usage command.
2. Run `readar auth status`. If authenticated, report the account and finish. Exit 3 means login is needed; other errors must be reported rather than treated as logged out.
3. Ask for the user's Readar account email, then run `readar auth login --email <email>` with closed/piped stdin and no TTY. This sends an email and returns a JSON challenge. Never repeat sending in a loop.
4. Ask the user to enter the received code locally with `readar auth verify --code <code>`, or pass the code to the CLI if the user explicitly supplies it. Use the same `npx ... readar` prefix if no bare executable exists. Codes expire; exit 2 means verification failed. Apple-only users need to bind their email in the App first.
5. Verify with `readar auth status` and report successful login only when it confirms the account. Never read, display or copy the session credential files into agent context.

## Usage

- Save generated text: `readar collect --file <file>` or pipe it to `readar collect --stdin`. Prefer a file or stdin for large content and shell-sensitive text.
- Search all saved content semantically: `readar search --query "怎样记住读过的内容" --type all`. Default `all` includes articles, podcast transcripts, questions/answers and personal thoughts. Title and body are always searched together; there is no `--fields` selector.
- Select `--type articles` or `--type episodes` for those scopes. Use `readar search --query "怎样记住读过的内容" --type questions` for question text, full answers and summaries, or `readar search --query "读完后用自己的话复述" --type thoughts` for only notes whose kind is `thought`, excluding question-kind notes.
- Unified search includes archived articles by default. Add `--exclude-archived` when requested; it has no effect on other types. Use a natural-language description of the intended meaning for hybrid search. `--mode hybrid` is the default; choose `--mode keyword` explicitly for keyword retrieval. `--query` is required (1–500 characters); `--limit` is 1–50, default 20.
- List/filter questions by keyword: `readar questions list --query <text>`.
- List/filter notes by keyword: `readar notes list --query <text>`. These listing commands retain date, episode and note-kind filters; semantic intent uses unified `search`.
- Read a question search hit: `readar questions get <record_id> --episode <episode_id>`. Read a thought search hit: `readar notes get <record_id> --episode <episode_id>`. Use the raw `record_id` field and returned parent; keep the composite search `id` opaque instead of passing or splitting it.
- Parse JSON stdout; inspect exit code and JSON stderr. Keep stdout and stderr separate.
- Continue lists using `next_cursor` with the same filters. A null cursor ends that listing's continuation; check content-search candidate caps as described below.
- Handle exit 3 by explaining that login is required. Do not loop login or refresh attempts.
- Question/note listing queries use the server keyword/full-text index with one request per page. Saved or edited content appears asynchronously. On `search_unavailable`, retry later; do not fall back to scanning episodes. Follow `next_cursor` until null, including after an empty page.

Unified semantic search needs a reviewed CLI revision whose `--help` lists `search` and the required `questions`/`thoughts` scopes; the installation ref above may predate them. The backend must separately deploy and configure `GET /v1/search` and backfill all required types. This guide does not confirm that production has enabled the endpoint. The skill supplies command guidance, not embeddings or server capabilities.

For `search`, preserve original snippets, IDs/types, `source_version`, anchors and child `record_id`/`episode_id`/`episode_title` when citing evidence. Question/thought `position_seconds` is a canonical episode record position or null, with null `track_version` and `segment_number`; it does not identify a natural/generated transcript track seek time. A null time remains null. Report `search_mode`, eventual consistency, and `indexing_status: partial` when relevant. An empty intermediate page may still have `next_cursor`; continue with the same account, API, query, type, archive selection and mode. Unified search cursors are opaque and separate from question/note listing cursors; changing from `questions` to `thoughts` or `all` requires a fresh search. The page limit may change. `candidate_limit_reached` means the server capped this candidate set, not that all matches have been exhausted.

Hybrid failure remains a failure: do not silently rerun keyword mode or interpret a service error as no matches. HTTP 503 `search_unavailable` (exit 1) can mean missing backend configuration; report it. An explicitly requested keyword retry may use `--mode keyword` as a new search. HTTP 410 `search_expired` (exit 2) requires a new search without `--cursor`; `invalid_cursor` also requires discarding the old cursor. Successful installation, local contract tests and backend deployment are separate checks.
