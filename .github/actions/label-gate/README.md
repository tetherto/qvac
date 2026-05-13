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
| `pull_request`, `pull_request_target` with `action=labeled` matching `inputs.label` | The applier (i.e. the event sender) is in `inputs.users` OR an active member of any `inputs.teams` team. **If non-trusted, the label is stripped.** |
| `pull_request`, `pull_request_target` with `action=synchronize` | The push sender is trusted **and** the existing label was applied by a trusted actor. **Otherwise the label is stripped.** |
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
2. **Non-trusted user pushes a commit while the label is applied
   (`synchronize`)** — the action denies AND strips the label. This
   prevents inheriting authorisation across a content change made by
   an untrusted actor.

In both cases the strip is idempotent (succeeds on 200/204 and is a
no-op on 404). The next event the action sees will be `unlabeled`,
which will fall through to the standard `not currently applied` deny.

## Inputs

| Name           | Required | Default                                                                            | Description                                                                                                                                  |
| -------------- | :------: | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`        |    no    | `verified`                                                                         | Label name required for PR-event authorisation.                                                                                              |
| `teams`        |    no    | `qvac-internal-dev`, `qvac-internal-merge`, `qvac-internal-release`                | Comma- and/or newline-separated team slugs (within the repository owner's org). Empty allowed if `users` is non-empty.                       |
| `users`        |    no    | `""`                                                                               | Comma- and/or newline-separated user logins. Authorised regardless of team membership. Login comparison is case-insensitive.                 |
| `github-token` |  **yes** | —                                                                                  | PAT with `read:org` (team membership lookups) and write access to PR labels (for stripping the label on non-trusted apply OR non-trusted synchronize). |

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
            qvac-internal-dev
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
  able to delete labels — to strip the gate label when a non-trusted
  user pushes new commits to a verified PR.

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
    ├── gate.test.mjs           # 26 policy tests, mock client
    ├── github-client.test.mjs  # 15 HTTP tests, mock fetch
    └── fixtures/               # 8 GitHub event payloads
```

## Tests

```sh
node --test .github/actions/label-gate/test/*.test.mjs
```

41 tests cover:

- **Policy** — every event type in the trust-model table; team-member,
  non-member, bot, and allowlisted-user appliers; synchronize from
  trusted and non-trusted senders; missing-PR-number; empty
  config; non-matching label name on `labeled` events.
- **HTTP** — retry-with-backoff on 5xx and 429; pagination on the
  timeline; 404-as-not-member semantics; idempotent label deletion;
  URL-encoding of label names; constructor input validation.
