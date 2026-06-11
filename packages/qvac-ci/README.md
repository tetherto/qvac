# @qvac/ci

CI utilities — a modular, extensible CLI for GitHub automation. Replaces inline YAML scripts with tested, versioned Node.js commands.

> **Note:** Development and feature builds are published to GitHub Packages (GPR) under the name `@qvac/ci-mono`. The unscoped `@qvac/ci` name is only available after a release-branch npm publish.

## Installation

```bash
npm install @qvac/ci
```

Or run directly in a GitHub Actions step:

```bash
npx @qvac/ci <command> [flags]
```

## Commands

### `pending-approvals`

Checks whether a PR has the required approvals from the right roles (Management, Team Lead, Member), then upserts a `## Review Status` comment on the PR summarising the current state.

Always exits with code `0` — this command is **informational only**. Merge enforcement is delegated to GitHub-native branch protection (CODEOWNERS + ruleset approval requirements).

> **Note:** This command is deprecated as part of the Tier 1 approval migration to native GitHub controls. It will be disabled after rollout validation.

```bash
qvac-ci pending-approvals \
  --pr-number 123 \
  --maintainers-team management \
  --team-leads-team team-leads \
  --min-approvals 2
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--pr-number` | PR number to check **(required)** | — |
| `--repo` | `owner/repo` string | `$GITHUB_REPOSITORY` |
| `--maintainers-team` | GitHub team slug for Management **(required)** | — |
| `--team-leads-team` | GitHub team slug for Team Leads **(required)** | — |
| `--min-approvals` | Minimum total approvals required | `2` |

**Environment variables (required):**

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Token used to post the review-status comment |
| `GITHUB_APP_ID` | GitHub App ID used for team membership resolution |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (PEM) |

Secrets are env-only — there are no `--token` flags. This prevents tokens from appearing in the process list, shell history, or CI log echoes.

**Example GitHub Actions step:**

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

**Comment format:**

The command upserts a single `## Review Status` comment on the PR (updates in place if one already exists):

```
## Review Status
**Current Status: ✅ APPROVED**
Approvals so far: Management: 1, Team Lead: 1
```

```
## Review Status
**Current Status: ❌ PENDING**
Approvals so far: Member: 1

Pending reviews: Needs 1 Management or Team Lead.
```

## Adding a new command

1. Create `lib/commands/<name>/index.js` — extend `Command`, implement `toCommand()` and `_run()`.
2. Create `lib/commands/<name>/helpers.js` — domain logic. Read secrets from `process.env`; never pass them as parameters. Export a mutable `helpers` object so tests can stub methods without a mock framework.
3. Register in `lib/commands/index.js` — `main.js` picks it up automatically.
4. Write tests in `test/unit/<name>/index.test.js` and `test/unit/<name>/helpers.test.js`. Mock all network calls.

## Development

```bash
npm install
npm test
npm run lint
npm run lint:fix
```

## Requirements

Node.js `>=18.0.0`

## License

Apache-2.0
