---
name: devops-why-my-pr-not
description: Diagnose why CI checks are not running on a PR and/or why a PR cannot be merged, by cross-referencing the live PR state (via gh CLI) against the repo's labels, teams, CODEOWNERS, label-gate trust model, and tier-based approval rules. Read-only by default — proposes labels / re-review comments / unblock actions in plan-then-apply mode. Use when a developer asks "why aren't my checks running", "why can't I merge", "what's blocking my PR", or invokes /devops-why-my-pr-not with a PR URL.
disable-model-invocation: true
---

# devops-why-my-pr-not

Self-service triage for the two most common DevOps support questions:

1. **"Why aren't my CI checks running?"** — use the canonical CI label and gate docs below; they define which labels, trust rules, and fork restrictions control job execution.
2. **"Why can't I merge?"** — use the canonical approval, CODEOWNERS, and branch-protection docs below; they define the required approvals, tiers, and merge conditions.

The skill cross-references the live PR state (via `gh`) against the canonical repo docs that describe the rules:

- [`docs/ci/LABELS.md`](../../../docs/ci/LABELS.md) — every CI-relevant label, what it gates, and who can apply it.
- [`docs/ci/TEAMS.md`](../../../docs/ci/TEAMS.md) — the four teams + the two pods (DevOps, SDK).
- [`.github/CODEOWNERS`](../../../.github/CODEOWNERS) — merge-approval routing.
- [`.github/actions/label-gate/README.md`](../../../.github/actions/label-gate/README.md) — `verified` trust model + strip policy.
- [`.github/workflows/approval-check-worker.yml`](../../../.github/workflows/approval-check-worker.yml) — tier1 / tier2 math + bypass rules.
- [`.github/teams/devops.json`](../../../.github/teams/devops.json), [`.github/teams/sdk.json`](../../../.github/teams/sdk.json) — pod leads + members.

**The docs are the source of truth.** The skill quotes them; it does not re-derive their rules.

## When to use this skill

**Use when:**

- A developer asks "why aren't my checks running on PR #N?"
- A developer asks "why can't I merge PR #N?" / "what's blocking my PR?"
- A reviewer asks "what does this PR still need before I can merge it?"
- User invokes `/devops-why-my-pr-not <PR URL>`

**Do NOT use when:**

- Reviewing a PR for correctness — use [`/devops-pr-review`](../devops-pr-review/SKILL.md) or [`/pr-review`](../pr-review/SKILL.md).
- Generating a PR description — use [`/devops-pr-create`](../devops-pr-create/SKILL.md) or [`/sdk-pr-create`](../sdk-pr-create/SKILL.md).
- Listing all open PRs in the pod — use [`/devops-pr-status`](../devops-pr-status/SKILL.md) or [`/sdk-pr-status`](../sdk-pr-status/SKILL.md).

## Inputs

- **Required**: PR URL or `<owner>/<repo>#<num>` shorthand (defaults `owner/repo` to `tetherto/qvac` if only `#<num>` is given).
- **Optional**: focus hint — `--ci`, `--merge`, or `--both` (default `--both`).

If the PR identifier is missing, ask once. Nothing else to ask up-front.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`). The token needs `repo` scope to read PR metadata, checks, and reviews on `tetherto/qvac`.
- `read:org` is **not** required by the skill itself, but the `label-gate` action in CI needs it via `PAT_TOKEN`. If your diagnosis traces back to a `label-gate` 5xx / auth error, that's the cause — see the rule mapping below.

The skill does not require a checked-out worktree. All inspection is via `gh`.

## Safety rules

This skill follows the [DevOps agentic-automation rule](../../rules/devops/agentic-automation.mdc) verbatim — read-only default; mutations are plan-then-apply per call.

- **Read-only with respect to the user's local working tree.** No `git switch`, `git checkout`, `git reset`, `git restore`, `git stash`, `git pull`, `git merge`, `git rebase`, `git cherry-pick`, `git clean`, `gh pr checkout`, or any write inside the user's working tree.
- **Read-only with respect to the PR's GitHub state by default.** No `gh pr edit`, no `gh api ... -X POST/PATCH/PUT/DELETE`, no `gh pr comment`, no `gh pr review` without explicit user confirmation per call.
- **Mutations are plan-then-apply.** When the diagnosis suggests a fix that the user could perform (apply a label, post `/review`, request re-review from a teammate, rebase to drop a merge conflict), print the exact `gh` command, wait for the user to type "yes" / "go" / "apply", then execute. A blanket "do everything" is not accepted — confirm per command.
- **Never apply `verified` on the user's behalf.** The `verified` gate is intentionally not self-service (per `LABELS.md`). The skill may *suggest* who to ask, never apply it.

## Efficiency rules

Cap at **6 shell calls** for a normal diagnosis. Cache fetched data once per invocation under `/tmp/why-pr-<num>-<short-sha>.json` so repeat queries within the same session do not re-hit GitHub.

| Call | Purpose |
|---|---|
| 1 | `gh pr view <num> --json number,title,state,isDraft,labels,author,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,latestReviews` |
| 2 | `gh pr checks <num> --json name,state,conclusion,workflow,link` (or `gh api .../check-runs?head_sha=<sha>` if `gh pr checks` is unavailable) |
| 3 | `gh api repos/<owner>/<repo>/commits/<sha>/status` (commit statuses for the `Tier-based Approval Check` non-check status) |
| 4 | `gh api repos/<owner>/<repo>/branches/<base>/protection` (only if the user explicitly opts into branch-protection inspection — needs admin/maintain) |
| 5 | (reserved for plan-then-apply mutation, e.g. `gh pr edit --add-label`) |
| 6 | (verification re-read of `gh pr view` after a mutation) |

If a single call covers multiple needs (e.g. `gh pr view --json` already lists labels and reviews), do not re-fetch.

## Workflow

### 1. Parse and validate the PR identifier

Accept any of:

- `https://github.com/tetherto/qvac/pull/12345`
- `tetherto/qvac#12345`
- `#12345` → resolves to `tetherto/qvac#12345`
- bare `12345` → resolves to `tetherto/qvac#12345`

Extract `<owner>`, `<repo>`, `<num>`. Reject if any are missing. Print the resolved canonical URL.

### 2. Read the canonical docs (once per session, cached)

Before fetching the PR, ensure you've read these in this turn (or already have them in context):

- [`docs/ci/LABELS.md`](../../../docs/ci/LABELS.md)
- [`docs/ci/TEAMS.md`](../../../docs/ci/TEAMS.md)
- [`.github/actions/label-gate/README.md`](../../../.github/actions/label-gate/README.md) — for the `verified` trust + strip rules

These are short. Read them in full. **Quote them in findings**, do not paraphrase from memory — the rules drift over time and the doc is authoritative.

For tier math, read [`approval-check-worker.yml`](../../../.github/workflows/approval-check-worker.yml) only when a tier finding is actually triggered (saves tokens for the common case).

For pod ownership, read [`.github/teams/devops.json`](../../../.github/teams/devops.json) / [`.github/teams/sdk.json`](../../../.github/teams/sdk.json) on demand when computing "who can apply `verified`" or "who is in your CODEOWNERS path."

### 3. Fetch live PR state

Single call:

```bash
gh pr view <num> -R <owner>/<repo> --json number,title,state,isDraft,labels,author,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,latestReviews,files
```

Cache the JSON to `/tmp/why-pr-<num>-<short-sha>.json`. Pull `headRefOid` for any subsequent `commits/<sha>/...` calls.

Then fetch checks (one call):

```bash
gh pr checks <num> -R <owner>/<repo> --json name,state,conclusion,workflow,link
```

If commit-status checks are needed (the `Tier-based Approval Check` is a commit status, not a check-run), one more call:

```bash
gh api "repos/<owner>/<repo>/commits/<headRefOid>/status"
```

### 4. Run the CI-not-running diagnosis (`--ci` / `--both`)

Walk down this checklist in order. Stop at the first match per dimension; print all matches across the checklist.

| # | Symptom (from PR JSON / checks JSON) | Diagnosis | Cite |
|---|---|---|---|
| C1 | PR `isDraft == true` AND a workflow has `pull_request: types: [opened, synchronize, reopened]` (default) | Draft PRs do not fire `pull_request` events for `ready_for_review` excluded triggers. Mark the PR as ready or push a new commit. | GitHub default `pull_request` event semantics |
| C2 | Workflow runs are present but jobs gated on `needs.label-gate.outputs.authorised == 'true'` are SKIPPED, AND `verified` label is missing | The `label-gate` denied because `verified` is not applied. Ask any active member of `@tetherto/qvac-internal-dev` / `-merge` / `-release` to apply it. | `docs/ci/LABELS.md § verified`, `label-gate/README.md § Trust model` |
| C3 | Same SKIPPED jobs, `verified` is present, but the latest `synchronize` event was a push by a non-trusted actor | `label-gate` strips `verified` on every `synchronize` from a non-trusted actor. A trusted actor must re-apply after reviewing the new commits. | `LABELS.md § verified — Behaviour on synchronize`, `label-gate/README.md § Strip policy` |
| C4 | `verified` label was *applied* by a non-trusted actor (look at the labeled-event applier in the timeline) and was immediately stripped | `label-gate` strips on apply by non-trusted actor (avoids a misleading "verified" social signal). | `LABELS.md § verified — Behaviour on apply by non-trusted actor`, `label-gate/README.md § Strip policy` |
| C5 | PR is from a fork (`headRepositoryOwner.login != tetherto`) AND only secret-bearing jobs are missing | `pull_request` from a fork gets a read-only `GITHUB_TOKEN` and no secrets. The `verified`-gated jobs intentionally won't run until a trusted actor verifies. | `LABELS.md § verified` |
| C6 | An expensive test/validation workflow is missing on a legacy `verify`-gated path (currently `pr-test-inference-addon-cpp*.yml`, `public-reusable-npm.yml`, `pr-models-validation-registry-server.yml`) AND `verified` is absent | Ask a trusted actor to apply `verified` — that is the canonical authorisation label across the repo. `verify` is **deprecated** and exists only on the legacy workflows listed in `LABELS.md § verify`; do not recommend applying it. | `LABELS.md § verify (deprecated)`, `LABELS.md § verified` |
| C7 | `pr-checks-sdk-pod.yml` jobs are skipped AND PR touches `packages/sdk/` from a fork AND `safe-to-test` is missing | SDK pod's check-running gate. Reviewer must apply `safe-to-test` after auditing the diff. | `LABELS.md § safe-to-test` |
| C8 | E2E suite did not run AND PR touches SDK AND neither `test-e2e-smoke` nor `test-e2e-full` is present | SDK E2E is opt-in via these labels. Apply the smoke variant for normal PR feedback. | `LABELS.md § test-e2e-smoke / test-e2e-full` |
| C9 | A workflow run is FAILED with `label-gate` exiting non-zero (red, not skipped) | Hard misconfiguration in `label-gate` — usually missing `PAT_TOKEN` or `read:org` API failure. This is a DevOps issue, not a label issue. | `label-gate/README.md § Exit policy` |
| C10 | Required check is in `IN_PROGRESS` state with no failure; user is just impatient | Wait. Or surface the slowest job's link. | `gh pr checks` output |

For each match, print **what the rule says** (one short quote pulled from the cite) plus **what the user should do** (a single concrete action).

### 5. Run the merge-blocked diagnosis (`--merge` / `--both`)

Walk this checklist in order, same rule: stop at first match per dimension, print all matches.

| # | Symptom | Diagnosis | Cite |
|---|---|---|---|
| M1 | `mergeable: "CONFLICTING"` or `mergeStateStatus: "DIRTY"` | Merge conflicts with `<baseRefName>`. Rebase or merge base into branch. | `gh pr view --json mergeable,mergeStateStatus` |
| M2 | `state: "CLOSED"` or `state: "MERGED"` | PR is not open. Re-open it (if closed) or there's nothing to merge (if merged). | n/a |
| M3 | `isDraft: true` | Draft PRs cannot be merged. Mark ready for review. | n/a |
| M4 | `reviewDecision: "REVIEW_REQUIRED"` AND CODEOWNERS approval not present | The CODEOWNERS team(s) for the touched paths must approve. Identify the team via the file's owners line; suggest 1-2 names from the team JSON. | `.github/CODEOWNERS`, `.github/teams/<pod>.json` |
| M5 | `reviewDecision: "CHANGES_REQUESTED"` | A review requested changes. Resolve the requested changes and either re-request review or have the reviewer dismiss. | n/a |
| M6 | `Tier-based Approval Check` commit status is `failure` | Tier requirements unmet. Read the bot's last comment for the exact `1/2 TL` / `0/1 Mgmt` deficit. Map deficit to which team must approve. (The bot's check defaults the PR to `tier1` unless the PR carries the `tier2` label.) | `LABELS.md § tier1, tier2`, `approval-check-worker.yml` |
| M7 | A required check (per `statusCheckRollup`) is FAILED | The required check must pass. Link to the failed run; if it's flake, re-run; if it's a real failure, fix. | `gh pr checks` |
| M8 | A required check is missing entirely from `statusCheckRollup` | Either the gating workflow is skipping (loop back to the CI section, usually a label-gate problem) OR a required check name in branch protection no longer matches a real job (DevOps issue). | branch-protection ruleset |
| M9 | Base branch protection updated mid-PR (new required check added) | Push an empty commit (`git commit --allow-empty`) to re-trigger checks against the new ruleset. | n/a |
| M10 | All checks green, all approvals satisfied, `mergeable: "MERGEABLE"`, `mergeStateStatus: "CLEAN"` | Nothing is blocking. Print "ready to merge" and the merge command the user can run themselves (do not run it). | n/a |

For tier-deficit diagnosis (M6), inline-quote the relevant block from `approval-check-worker.yml`:

- **tier1**: `1 Team Member + 1 (TL or Mgmt)`
- **tier2**: `1 Team Member + 1 TL + 1 Mgmt`
- **bypass**: `2+ Mgmt` (any tier), or `2+ TL` (tier1), or `2+ TL + 1+ Mgmt` (tier2)

When suggesting reviewers, prefer **named** people from `.github/teams/<pod>.json` for the touched pod (DevOps for `.github/**` + `scripts/**`, SDK for the SDK pod paths). If the PR touches both, pick from both pods.

### 6. Render the report

Print one consolidated report. Two top-level sections (omit a section if the user asked for a single dimension).

```
PR: <owner>/<repo>#<num> — <title>
Author: @<login>   Base: <baseRefName>   Head: <headRefName>@<short-sha>
State: <state> | Draft: <isDraft> | Mergeable: <mergeable>/<mergeStateStatus> | Review: <reviewDecision>
Labels: <comma-separated>

── CI: are checks running? ──────────────────────────────────────────
[<symbol>] <C#> <one-line summary>
   Rule:    <one-line quote from cited doc>
   Action:  <one concrete next step>
   Cite:    <relative link>

[<symbol>] <C#> ...

(or "✓ All expected checks are running.")

── Merge: can it land? ───────────────────────────────────────────────
[<symbol>] <M#> <one-line summary>
   Rule:    <one-line quote from cited doc>
   Action:  <one concrete next step>
   Cite:    <relative link>

[<symbol>] <M#> ...

(or "✓ All merge requirements satisfied.")

── Suggested next actions ───────────────────────────────────────────
1. <concrete action> — <user-friendly description>
2. ...
```

Use simple symbols: `[!]` for blocking, `[~]` for soft (e.g. waiting), `[i]` for informational, `[✓]` for satisfied. No emojis (per repo convention).

### 7. Plan-then-apply mutations (only if user opts in)

The skill MAY propose at most one mutation per finding. Each proposal prints the exact command and waits for explicit confirmation. Examples:

- **Apply `safe-to-test`** (only after the user confirms they have audited the fork's diff):
  ```bash
  gh pr edit <num> -R <owner>/<repo> --add-label safe-to-test
  ```
- **Apply `tier2`** (only when the touched paths warrant it — usually security or infra):
  ```bash
  gh pr edit <num> -R <owner>/<repo> --add-label tier2
  ```
- **Re-trigger approval bot**:
  ```bash
  gh pr comment <num> -R <owner>/<repo> --body "/review"
  ```
- **Request re-review from a specific approver**:
  ```bash
  gh api -X POST repos/<owner>/<repo>/pulls/<num>/requested_reviewers \
    -f reviewers='["<login>"]'
  ```
- **Mark draft PR as ready for review**:
  ```bash
  gh pr ready <num> -R <owner>/<repo>
  ```

**Never propose** applying `verified` on the user's own PR. The whole point of `verified` is third-party sign-off (per `LABELS.md`). If the user's PR is missing `verified`, the suggestion is "ask <named team member from devops.json or sdk.json> to apply it" — not "I'll apply it for you."

After any mutation, re-run step 3 (single `gh pr view`) and re-render only the section(s) that changed. Print one verification line: `Verified: <label X> now present | reviewers <Y, Z> requested | etc.`

### 8. Stop conditions (fail-stop)

Stop and report (do not guess) when:

- `gh auth status` reports unauthenticated → tell the user to run `gh auth login`.
- The PR JSON returns 404 → wrong number / wrong repo / private repo.
- The skill needs to read branch protection but the user lacks permission (`HTTP 403`) → state the limitation; the merge-blocked diagnosis falls back to "what we can see from PR state alone".
- The diagnosis returns zero findings AND the user clearly believes something is broken → say so; offer to dump the raw PR JSON for the user to inspect.

## Quality checklist

Before printing the final report, verify:

- [ ] Each finding cites a real rule from `docs/ci/LABELS.md`, `docs/ci/TEAMS.md`, `label-gate/README.md`, `approval-check-worker.yml`, or `CODEOWNERS` — not from memory.
- [ ] Each finding has both a "Rule" (one-line quote) and an "Action" (one concrete step).
- [ ] Suggested approvers (for tier deficits / CODEOWNERS) are named from `.github/teams/<pod>.json`, not invented.
- [ ] No mutation has been executed without an explicit per-command confirmation.
- [ ] `verified` was never proposed for self-application.
- [ ] Total `gh` shell calls ≤ 6 for a read-only diagnosis (≤ 8 if a mutation + verification was performed).

## References

- Label catalogue: [`docs/ci/LABELS.md`](../../../docs/ci/LABELS.md)
- Team catalogue: [`docs/ci/TEAMS.md`](../../../docs/ci/TEAMS.md)
- `label-gate` trust model: [`.github/actions/label-gate/README.md`](../../../.github/actions/label-gate/README.md)
- Tier approval math: [`.github/workflows/approval-check-worker.yml`](../../../.github/workflows/approval-check-worker.yml)
- Merge-routing: [`.github/CODEOWNERS`](../../../.github/CODEOWNERS)
- DevOps pod metadata: [`.github/teams/devops.json`](../../../.github/teams/devops.json)
- SDK pod metadata: [`.github/teams/sdk.json`](../../../.github/teams/sdk.json)
- Agentic automation rules (mutation policy): [`.cursor/rules/devops/agentic-automation.mdc`](../../rules/devops/agentic-automation.mdc)
- Generic PR review skill: [`.cursor/skills/pr-review/SKILL.md`](../pr-review/SKILL.md)
- DevOps PR review skill: [`.cursor/skills/devops-pr-review/SKILL.md`](../devops-pr-review/SKILL.md)
