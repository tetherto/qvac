# label-gate

Authorise secret-bearing GitHub Actions jobs based on whether a trusted
actor has applied a "verified" label to the pull request.

This action exists to replace per-job environment approvals as the primary
trust gate for jobs that consume secrets from PR-triggered workflows. It
generalises the existing `authorize-pr` composite action into a single,
configurable building block.

## Trust model

The action returns `authorised=true` iff one of the following is true:

| Event                                  | Authorised when                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `push`, `workflow_dispatch`, `workflow_call`, `schedule`, `release`, `repository_dispatch` | Always (intrinsically trusted event sources). |
| `pull_request`, `pull_request_target` from an **internal same-repo branch** (`head.repo` == base repo) | Always — no label required. Pushing a branch to the base repo requires write access, so the PR is inherently trusted. The `verified` label gate is for **external forks only**. |
| `pull_request`, `pull_request_target` with `action=labeled` matching `inputs.label` | The applier (i.e. the event sender) is in `inputs.users` OR an active member of any `inputs.teams` team. **If non-trusted, the label is stripped.** |
| External-fork `pull_request`, `pull_request_target` with `action=synchronize` | Never. Any fork commit change invalidates the commit-specific approval, regardless of who pushed it. **The label is stripped and re-review is required.** |
| `pull_request`, `pull_request_target` with any other action | A trusted actor has previously applied the label (verified by walking the PR timeline). Deny only — no strip (the synchronize path will clean up on the next push). |
| Anything else                          | Never (fail closed).                                                                                     |

"Trusted" = login is in the `users` allowlist OR is an active member of
any of the configured GitHub teams. Login comparison is
case-insensitive; `users` is checked first to avoid an API call.

### Strip policy

The action actively removes the gate label whenever the visible PR
state would otherwise misrepresent the security state:

1. **Non-trusted user applies the gate label** — the action denies
   AND strips the label. This prevents a "look, it's verified" social
   signal that doesn't actually mean the PR is authorised.
2. **Any commit is pushed to an external fork PR while the label is applied
   (`synchronize`)** — the action denies AND strips the label, including when
   a maintainer pushes through "allow edits". This prevents authorisation from
   carrying across any content change.

In both cases the strip is idempotent (succeeds on 200/204 and is a
no-op on 404). The next event the action sees will be `unlabeled`,
which will fall through to the standard `not currently applied` deny.

## Inputs

| Name           | Required | Default                                                                            | Description                                                                                                                                  |
| -------------- | :------: | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`        |    no    | `verified`                                                                         | Label name required for PR-event authorisation.                                                                                              |
| `teams`        |    no    | `qvac-internal-merge`, `qvac-internal-release`                                      | Comma- and/or newline-separated team slugs (within the repository owner's org). Empty allowed if `users` is non-empty. Scoped to merge + release: only those teams may apply `verified` (individual contributor / partner teams are excluded by design). |
| `users`        |    no    | `""`                                                                               | Comma- and/or newline-separated user logins. Authorised regardless of team membership. Login comparison is case-insensitive.                 |
| `github-token` |  **yes** | —                                                                                  | PAT with `read:org` (team membership lookups) and write access to PR labels (for stripping a non-trusted apply or any external-fork synchronize). |

`teams` and `users` are both optional individually but the union must
contain at least one entry; an empty union always denies on PR events.

## Outputs

| Name         | Description                                                            |
| ------------ | ---------------------------------------------------------------------- |
| `authorised` | `"true"` or `"false"`. Downstream jobs gate on `if: needs.<id>.outputs.authorised == 'true'`. |

## Exit policy

- **Soft denial** (label not applied, applier not trusted, etc.) — the
  action exits 0 with `authorised=false`. The gate job stays green and
  downstream jobs skip via their `if:` condition.
- **Hard misconfiguration** (missing token, unreadable event payload,
  unhandled GitHub API error) — the action exits non-zero so the gate
  job goes red and the failure is loud rather than silent. Downstream
  jobs still skip because the output isn't `true`.

## Usage

```yaml
jobs:
  authorise:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    outputs:
      authorised: ${{ steps.gate.outputs.authorised }}
    steps:
      - uses: actions/checkout@v4
      - id: gate
        uses: ./.github/actions/label-gate
        with:
          label: verified
          teams: |
            qvac-internal-merge
            qvac-internal-release
          users: |
            release-bot
          github-token: ${{ secrets.PAT_TOKEN }}

  privileged:
    needs: [authorise]
    if: needs.authorise.outputs.authorised == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "running with secrets"
```

## Required token scopes

- `read:org` — to query `/orgs/{org}/teams/{slug}/memberships/{login}`.
- `pull-requests: write` (workflow permission) **and** the PAT must be
  able to delete labels — to strip the gate label whenever an external
  fork PR's commit changes.

`GITHUB_TOKEN` does not have `read:org`, so a PAT (or fine-grained PAT,
or GitHub App installation token) is required.

## Implementation

Pure-Node 20 action. No external dependencies, no bundler, no `dist/`
to maintain — every file in `src/` runs directly under the action
runner's bundled Node.

```
.github/actions/label-gate/
├── action.yml             # using: node20, main: src/index.mjs
├── README.md
├── src/
│   ├── index.mjs          # action entrypoint (input/output plumbing)
│   ├── gate.mjs           # pure decision logic (testable in isolation)
│   └── github-client.mjs  # native-fetch GitHub REST client (3 endpoints)
└── test/
    ├── gate.test.mjs           # policy tests, mock client
    ├── github-client.test.mjs  # 15 HTTP tests, mock fetch
    └── fixtures/               # 8 GitHub event payloads
```

## Tests

```sh
node --test .github/actions/label-gate/test/*.test.mjs
```

63 tests cover:

- **Policy** — every event type in the trust-model table; internal same-repo
  ready/draft PRs; team-member, non-member, bot, and allowlisted-user
  appliers; every external-fork synchronize invalidating approval;
  missing-PR-number; empty config; non-matching label name on `labeled` events.
- **HTTP** — retry-with-backoff on 5xx and 429; pagination on the
  timeline; 404-as-not-member semantics; idempotent label deletion;
  URL-encoding of label names; constructor input validation.
