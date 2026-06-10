# @qvac/ci

CI utilities — a modular, extensible CLI for GitHub automation. Replaces inline YAML scripts with tested, versioned Node.js commands.

## Installation

```sh
npm install @qvac/ci
```

> **Note:** Development and feature builds are published to GitHub Packages (GPR) under the name `@qvac/ci-mono`. The unscoped `@qvac/ci` name is only available after a release-branch npm publish.

Or run directly in a GitHub Actions step:

```yaml
- run: npx @qvac/ci pending-approvals --pr-number ${{ github.event.pull_request.number }}
```

## Usage

```
qvac-ci <command> [flags]

Commands:
  pending-approvals   Check PR approval status and post a review-status comment

Flags:
  --help, -h          Show help
  --version, -v       Show version
```

## Commands

### `pending-approvals`

Checks whether a PR has the required approvals from the right roles (Management/Team Lead and Members), then upserts a `## Review Status` comment on the PR summarising the current state.

```
qvac-ci pending-approvals \
  --pr-number 123 \
  --maintainers-team management \
  --team-leads-team team-leads \
  --min-approvals 2
```

| Flag | Description | Default |
|------|-------------|---------|
| `--pr-number` | PR number to check **(required)** | — |
| `--repo` | `owner/repo` string | `$GITHUB_REPOSITORY` |
| `--maintainers-team` | GitHub team slug for Management **(required)** | — |
| `--team-leads-team` | GitHub team slug for Team Leads **(required)** | — |
| `--min-approvals` | Minimum total approvals required | `2` |

Always exits with code `0` — this command is **informational only**. It surfaces pending review context as a PR comment; merge enforcement is delegated to GitHub-native branch protection (CODEOWNERS + ruleset approval requirements).

#### Comment format

The command upserts a single `## Review Status` comment on the PR. Examples of what it posts:

**Approved:**
```
## Review Status
**Current Status: ✅ APPROVED**
Approvals so far: Management: 1, Team Lead: 1
```

**Pending — missing codeowner approval:**
```
## Review Status
**Current Status: ❌ PENDING**
Approvals so far: Member: 1

Pending reviews: Needs 1 Management or Team Lead.
```

**Pending — codeowner present but total below threshold:**
```
## Review Status
**Current Status: ❌ PENDING**
Approvals so far: Management: 1

Pending reviews: Needs 1 more from Management, Team Lead, or Member.
```

Zero-count roles are omitted from the summary line. If the comment already exists (identified by the `## Review Status` marker) it is updated in-place rather than creating a new one.

### Environment variables (required)

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Token used to post the review-status comment |
| `GITHUB_APP_ID` | GitHub App ID used for team membership resolution |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (PEM) |

**Secrets are never accepted as CLI flags.** They must be supplied via environment variables. This prevents tokens from appearing in the process list (`ps aux`), shell history, or CI log echoes.

### Example GitHub Actions step

```yaml
- name: Check PR approvals
  env:
    GITHUB_TOKEN: ${{ secrets.CI_TOKEN }}
    GITHUB_APP_ID: ${{ secrets.APP_ID }}
    GITHUB_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
  run: |
    npx @qvac/ci pending-approvals \
      --pr-number ${{ github.event.pull_request.number }} \
      --maintainers-team management \
      --team-leads-team team-leads \
      --min-approvals 2
```

## Security model

| Threat | Mitigation |
|--------|-----------|
| Token in process list | Secrets are env-only; no `--token` flag exists |
| Token in shell history | Same — nothing to type |
| Token in CI log echo | Same — nothing to echo |
| Token in error messages | `sanitizeError()` + `redact()` on all output |
| CodeQL taint flow argv→API | `validatePrNumber()` + `validateRepo()` applied before every call |
| Prototype pollution via argv | `paparam` used (no `minimist`); `paparam` does not expose raw prototype-writable objects |
| Dependency CVEs | Minimal runtime deps; run `npm audit` before releasing |
| Secrets in test files | All network calls mocked; fixture tokens are fake sentinel values |
| Stack trace leaking secrets | `err.message` only, never `err.stack` |

## How to add a new subcommand

1. **Create** `lib/commands/<name>/index.js`:

   ```js
   'use strict'
   const { command, flag, summary, footer } = require('paparam')
   const { Command } = require('../../command')
   const { validatePrNumber, sanitizeError, exitWithError } = require('../../helpers')
   const { myDomainFn } = require('./helpers')

   class MyCommand extends Command {
     constructor () {
       super({
         name: 'my-command',
         description: 'One-line description for --help',
         secrets: [
           { envVar: 'MY_SECRET', description: 'Token for ...' }
         ]
       })
     }

     toCommand () {
       const cmd = command(
         'my-command',
         summary(this.description),
         flag('--some-flag <value>', 'A flag'),
         footer(this._secretsFooter()),
         async () => {
           try { await this.run(cmd.flags) }
           catch (err) { exitWithError(sanitizeError(err)) }
         }
       )
       return cmd
     }

     async _run (flags) {
       // secrets already validated by base class
       // validate inputs first
       // call helpers — never pass secrets as arguments
     }
   }

   module.exports = new MyCommand()
   ```

2. **Create** `lib/commands/<name>/helpers.js` — domain logic. Read secrets from `process.env` inside functions; never pass them as parameters.

3. **Register** in `main.js` — add one line:

   ```js
   const myCommand = require('./lib/commands/my-command/index')
   // ...
   const prog = command(
     'qvac-ci',
     // ...
     pendingApprovals.toCommand(),
     myCommand.toCommand()   // ← add this
   )
   ```

4. **Write tests** in `test/unit/<name>-index.test.js` and `test/unit/<name>-helpers.test.js`. Mock all network calls. Use fake sentinel tokens (`ghp_FAKE_TOKEN_FOR_TESTING_ONLY_...`) — they match the `redact()` pattern and let you test redaction logic.

Nothing in the framework layer (`main.js`, `lib/command.js`, `lib/helpers.js`) needs to change unless you are adding new generic behaviour that should be available to all commands.

## Development

```sh
# Install dependencies
npm install

# Run tests
npm test

# Lint
npm run lint

# Lint + auto-fix
npm run lint:fix

# Check for dependency vulnerabilities
npm run audit
```

## Publishing

This package has no build step — it is plain Node.js CJS with no compilation or bundling required.

Publishing is handled by CI. The `lint-and-test` job must pass before any publish job runs, so a failing test suite will block the publish in the pipeline.

```sh
# Manual publish (ensure tests pass locally first)
npm test && npm publish
```

## Requirements

Node.js `>=18.0.0`

## License

Apache-2.0
