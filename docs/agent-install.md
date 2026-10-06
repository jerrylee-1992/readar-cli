# Install and use Readar CLI as an agent

A user can ask an agent:

> 请按照 https://github.com/jerrylee-1992/readar-cli/blob/codex/agent-install/docs/agent-install.md 安装 Readar CLI，验证版本和帮助，并告诉我后续调用命令。

## Install from GitHub

The official public repository is https://github.com/jerrylee-1992/readar-cli. This project is not published to npm; do not install a similarly named registry package. Use the installation-enabled `codex/agent-install` ref below, or an explicitly supplied reviewed commit SHA.

1. Check `node --version`, `npm --version` and `git --version`: Node.js 22+ is required. If missing, use the user's established installation method or the official installer for their OS. One sentence to the agent starts the whole workflow; it does not remove these runtime requirements.
2. Install from the public Git URL into npm's execution cache and verify both commands below. npm installs build dependencies and runs `prepare` to compile the executable. No manual cloning, building, global write permission or GitHub login is required:

   ```sh
   npx -y --package='git+https://github.com/jerrylee-1992/readar-cli.git#codex/agent-install' readar --version
   npx -y --package='git+https://github.com/jerrylee-1992/readar-cli.git#codex/agent-install' readar --help
   ```

3. Report the version and the exact `npx ... readar` prefix for subsequent commands. Cached execution does not add a bare `readar` command to the shell's PATH. Do not report success just because npm exits successfully.

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

Network failures should be reported without repeatedly reinstalling. Installing does not send email or create a login session. Ask for login details only when the user also wants to sign in.

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
