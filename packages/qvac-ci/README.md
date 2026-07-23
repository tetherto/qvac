# @qvac/ci

CLI utilities for GitHub CI automation. Replaces inline YAML scripts with tested, versioned Node.js commands.

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

Checks whether a PR has the required approvals from the right roles (Management, Team Lead, Member) and upserts a `## Review Status` comment on the PR summarising the current state.

Always exits `0` — informational only. Merge enforcement is handled by GitHub-native branch protection (CODEOWNERS + ruleset requirements).

> **Deprecated:** This command will be removed after the Tier 1 approval migration to native GitHub controls is complete.

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

**Required environment variables:**

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Token used to post the review-status comment |
| `GITHUB_APP_ID` | GitHub App ID for team membership resolution |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (PEM) |

Secrets are env-only — no `--token` flags — to prevent tokens from appearing in the process list or CI logs.

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

## Adding a new command

1. Create `lib/commands/<name>/index.js` — extend `Command`, implement `toCommand()` and `_run()`.
2. Create `lib/commands/<name>/helpers.js` — domain logic. Read secrets from `process.env`; never pass them as parameters. Export a mutable `helpers` object so tests can stub methods without a mock framework.
3. Register in `lib/commands/index.js` — add an explicit `import` and push `.toCommand()` to the `commands` array. `main.js` spreads the array.
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
