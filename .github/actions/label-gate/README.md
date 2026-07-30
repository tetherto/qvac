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
| `pull_request`, `pull_request_target` with `action=labeled` matching `inputs.label` | The applier (i.e. the event sender) is in `inputs.users` OR an active member of any `inputs.teams` team. On success the approval is **bound to the current head SHA** via a `qvac/fork-verified` commit status. **If non-trusted, the label is stripped.** |
| External-fork `pull_request`, `pull_request_target` with `action=synchronize` | Never. Any fork commit change invalidates the commit-specific approval, regardless of who pushed it. **The label is stripped and re-review is required.** |
| `pull_request`, `pull_request_target` with any other action (`opened` / `reopened` / `ready_for_review` / `edited` / …) | A trusted actor previously applied the label **AND the current head SHA carries the `qvac/fork-verified` approval status**. Approval is SHA-bound, not order-based, so a stale approval for an earlier commit cannot authorise a new one. Deny only — no strip. |
| Anything else                          | Never (fail closed).                                                                                     |

"Trusted" = login is in the `users` allowlist OR is an active member of
any of the configured GitHub teams. Login comparison is
case-insensitive; `users` is checked first to avoid an API call.

### SHA-bound approval

Authorisation follows the **approved commit**, not workflow-event ordering. When a
trusted actor applies the label, the action records a `qvac/fork-verified` commit
status (state `success`) on the exact head SHA. Every subsequent privileged run
authorises only if the current head SHA carries that status.

This closes two bypasses (reported by Marcus) where a stale approval for commit A
was replayed onto a later commit B whose run superseded the pending label-strip run:

- **Draft → Ready:** verify A → mark draft → push B → mark ready. The
  `ready_for_review` run carries head B, which has no approval status → denied.
- **Close → Reopen:** verify A → push B → close + reopen. The `reopened` run
  carries head B → denied.

Recovery: a trusted actor re-applying the label at the new head mints a fresh
approval for that SHA. The companion `authorize-pr` action reads the same status,
so **both fork gates are SHA-bound** and neither treats event ordering as proof.

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
| `github-token` |  **yes** | —                                                                                  | PAT with `read:org` (team membership lookups), write access to PR labels (for stripping a non-trusted apply or any external-fork synchronize), and `repo:status` (to record + read the `qvac/fork-verified` SHA-bound approval). |

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
- `repo:status` (commit statuses: write) — to record the `qvac/fork-verified`
  approval on the approved head SHA and read it back on later runs. Because
  the PAT carries this scope, no per-workflow `statuses: write` permission
  change is required.

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
│   └── github-client.mjs  # native-fetch GitHub REST client (5 endpoints)
└── test/
    ├── gate.test.mjs           # policy tests, mock client
    ├── github-client.test.mjs  # 15 HTTP tests, mock fetch
    └── fixtures/               # 8 GitHub event payloads
```

## Tests

```sh
node --test .github/actions/label-gate/test/*.test.mjs
```

Tests cover:

- **Policy** — every event type in the trust-model table; internal same-repo
  ready/draft PRs; team-member, non-member, bot, and allowlisted-user
  appliers; every external-fork synchronize invalidating approval;
  missing-PR-number; empty config; non-matching label name on `labeled` events.
- **SHA-bound approval** — a trusted `labeled` event records the commit status;
  `draft→ready` and `close→reopen` flips at a new SHA are denied; the same SHA
  stays authorised across events; re-labeling at the new SHA mints a fresh
  approval; a missing head SHA fails closed.
- **HTTP** — retry-with-backoff on 5xx and 429; pagination on the
  timeline; 404-as-not-member semantics; idempotent label deletion;
  URL-encoding of label names; constructor input validation;
  `setCommitStatus` POST body + `hasApprovalStatus` newest-first / fail-closed.
