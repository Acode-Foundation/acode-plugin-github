# Contributing

Thanks for helping improve the GitHub plugin for Acode. Keep changes focused,
maintainable, and compatible with the existing plugin-facing commands,
settings, `gh://` URLs, and filesystem behavior unless a change explicitly
requires an API migration.

## Prerequisites

- Node.js 24.18 LTS, as recorded in `.nvmrc`, or Node.js 26 or newer.
- npm 12.0.2, as recorded by the `packageManager` field in `package.json`.
- Acode on a device that can reach your development machine for manual plugin
  testing.

Install the exact locked dependency graph before working on a change:

```sh
npm ci
```

## Project structure

- `src/main.js` registers the plugin commands, settings, and user workflows.
- `src/githubFs.js` implements Acode's `gh://` repository and gist filesystem.
- `src/githubService.js` is the plugin-owned Octokit boundary for the GitHub REST
  operations the plugin uses.
- `src/githubAccount.js` owns legacy PAT migration and runs authenticated read
  and write operations.
- `src/githubDataStore.js` owns account-scoped repository, branch, and gist
  caches.
- `src/githubLauncher.js` registers the lightweight sidebar-tab launcher for
  the full GitHub workspace.
- `src/githubPage.js` and its scoped stylesheet implement the responsive GitHub
  workspace using the plugin page Acode provides, without duplicating command
  behavior.
- `src/githubAuth/` contains the GitHub App device-flow, encrypted-session,
  refresh, and native HTTP engine.
- `scripts/dev/` contains the watcher, HTTP development server, network
  discovery, and atomic ZIP packager.
- `test/` contains Node unit and integration tests.
- `webpack.config.js` builds `dist/main.js` and waits for `dist.zip` to finish
  before reporting a successful compilation.

## Development workflow

Start the watched development build and local HTTP server with:

```sh
npm run dev
```

The command prints an address such as `http://192.168.1.10:5500`. Install or
reinstall the development plugin in Acode from:

```text
http://<local-ip>:5500/dist.zip
```

Webpack rebuilds continuously. Each successful compilation creates the archive
in a temporary file and atomically replaces `dist.zip` only after packaging is
complete. The development server disables caching, so reinstalling from the
same URL receives the latest completed archive. Stop the watcher and server
with Ctrl+C.

### GitHub App authentication development

Every build includes GitHub App Device Flow and works with stock Acode. Acode
1.12.3 (version code 973) and newer exposes GitHub App sign-in with PAT as an
alternative. Older versions expose only the manual PAT flow and never create a
GitHub App session.

Both modes persist the versioned session as an AES-256-GCM-SIV encrypted
`localStorage` envelope. The cipher is implemented in pure JavaScript and does
not depend on Web Crypto, IndexedDB, an initialization context, or a custom
Acode API. Existing `localStorage['github-token']` PATs are validated, encrypted,
and removed only after the encrypted save succeeds. Startup adopts these PATs
without making a request; the first successful GitHub operation triggers one
deduplicated background validation and migration. Unpublished native-secret,
IndexedDB, and experimental credential-vault formats are not migrated.

Use a separate development GitHub App for end-to-end testing. The current test
App is **Acode GitHub Development**, owned by `deadlyjack`, with this setup:

- Homepage: `https://github.com/acode-foundation/acode-plugin-github`
- Installable on: Any account (share the development URL only with testers)
- Device Flow and expiring user tokens: enabled
- Repository permissions: Contents write, Workflows write, Metadata read
- User permissions: Gists write
- Callback and setup URLs: empty
- Webhooks: disabled

Do not generate a client secret, private key, or webhook secret. Device Flow
uses only the App's public client ID. Copy the tracked template to both ignored
configuration files:

POSIX shells:

```sh
cp .env.example .env.local
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
Copy-Item .env.example .env
```

Put the development App's `ACODE_GITHUB_CLIENT_ID` and
`ACODE_GITHUB_INSTALL_URL` in `.env.local`. Put the production App's values in
`.env`. `npm run dev` reads only `.env.local`. `npm run build` and
`npm run dev:release` read only `.env`; the latter watches and serves the
minimized production configuration for testing. The older
`npm run dev -- --release` spelling remains supported. Explicit shell variables
take precedence over the file selected for that build mode, and the watcher
prints a warning when an override is active without printing its value. Both
files are ignored by Git; `.env.example` is the only tracked template. Builds
fail closed when either value is absent or when the installation URL is not an
HTTPS GitHub App installation URL.

Only one watcher may run for this checkout because every mode writes `dist/`
and `dist.zip` and serves port 5500. A second watcher exits before compiling and
reports the active mode and PID. Stop the first watcher with Ctrl+C before
switching modes. Stale watcher locks are recovered automatically.

The client ID and installation URL are public identifiers. Never add a client
secret, private key, access token, refresh token, or device code to source,
environment examples, logs, snapshots, or archives. Device Flow and GitHub API
requests must use Acode's stock native HTTP bridge. Access and refresh tokens
must never be stored or logged in plaintext.

The encryption key is an immutable bundled constant. It prevents casual
plaintext inspection but is intentionally not described as secure plugin
isolation: the key is recoverable from `dist.zip`, and Acode plugins execute in
a shared WebView. Keep this limitation explicit when changing authentication
documentation or storage behavior.

## npm commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch a development bundle using `.env.local`, rebuild `dist.zip`, and serve it over HTTP. |
| `npm run dev:release` | Watch and serve a minimized production bundle using `.env`. |
| `npm run dev -- --release` | Compatibility spelling for `npm run dev:release`. |
| `npm run build` | Create the minimized production bundle using `.env` and package it into `dist.zip`. |
| `npm test` | Run all Node unit and HTTP integration tests. |
| `npm run check` | Check formatting, recommended lint rules, and import organization with Biome. |
| `npm run check:fix` | Apply Biome's safe formatting, lint, and import fixes. |
| `npm run deps:audit` | Require npm's low-severity security audit to pass. |
| `npm run deps:outdated` | Report outdated direct dependencies as JSON. |

## Code and test expectations

- Use Biome as the formatter and linter. Run `npm run check:fix` after editing,
  then ensure `npm run check` is clean.
- Add or update focused Node tests for every behavior change. Keep filesystem,
  network, packaging, and request code testable through exported helpers.
- Do not add editor-specific execution logic under `.vscode`; executable
  development tooling belongs in `scripts/dev`.
- Keep archive creation awaited and atomic. A successful webpack compilation
  must mean the new `dist.zip` is complete and ready to serve.
- Preserve no-cache and CORS headers on the development server.
- Keep production dependencies limited to code used by the plugin bundle.
- Do not commit generated `dist/`, `dist.zip`, dependency directories, tokens,
  or other credentials.

## Required checks

Run the complete validation sequence before opening a pull request:

```sh
npm ci
npm run check
npm test
npm run build
npm run deps:audit
npm run deps:outdated
```

`npm run deps:audit` must report zero vulnerabilities and
`npm run deps:outdated` must return `{}`. Validate that `dist.zip` contains the
production `main.js`, `plugin.json`, `icon.png`, and the user-facing
`readme.md`.

The production bundle baseline is 252 KiB. Investigate any increase above 10%
(approximately 277 KiB or 283,852 bytes) before submitting a change.

## Pull request checklist

- [ ] The change is focused and avoids redundant or unrelated refactoring.
- [ ] New or changed behavior has unit or integration coverage.
- [ ] Biome, tests, development build, and production build pass.
- [ ] Audit reports zero vulnerabilities and outdated reports `{}`.
- [ ] `dist.zip` is complete and serves correctly from the unchanged HTTP URL.
- [ ] Watcher and server child processes stop cleanly after Ctrl+C.
- [ ] Acode repository and gist workflows affected by the change were manually
      smoke-tested.
- [ ] Plugin commands, settings, `gh://` URLs, and public behavior remain
      compatible, or the pull request clearly documents the intended migration.
