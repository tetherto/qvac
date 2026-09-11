---
name: qv-devops-why-my-pr-not
description: Diagnose why CI checks are not running on a PR and/or why a PR cannot be merged by comparing live PR state with current labels, CODEOWNERS, fork trust, and approval configuration. Read-only by default. Use when a developer asks why checks are missing, why a PR cannot merge, or invokes /qv-devops-why-my-pr-not with a PR URL.
disable-model-invocation: true
---

# devops-why-my-pr-not

Self-service triage for the two most common DevOps support questions:

1. **"Why aren't my CI checks running?"** — use the canonical CI label and gate docs below; they define which labels, trust rules, and fork restrictions control job execution.
2. **"Why can't I merge?"** — use the current approval workflow, CODEOWNERS,
   and branch-protection state; they define required approvals and merge conditions.

The skill cross-references the live PR state (via `gh`) against the canonical repo docs that describe the rules:

- [`docs/ci/LABELS.md`](../../../docs/ci/LABELS.md) — every CI-relevant label, fork-ci environment, `fork-approval`, and what each gates.
- [`docs/ci/TEAMS.md`](../../../docs/ci/TEAMS.md) — the four teams + the two pods (DevOps, SDK).
- [`.github/CODEOWNERS`](../../../.github/CODEOWNERS) — merge-approval routing.
- [`.github/workflows/check-approvals.yml`](../../../.github/workflows/check-approvals.yml) — current approval check and minimum approval configuration.
- [`.github/teams/devops.json`](../../../.github/teams/devops.json), [`.github/teams/sdk.json`](../../../.github/teams/sdk.json) — pod leads + members.

**The docs are the source of truth.** The skill quotes them; it does not re-derive their rules.

## When to use this skill

**Use when:**

- A developer asks "why aren't my checks running on PR #N?"
- A developer asks "why can't I merge PR #N?" / "what's blocking my PR?"
- A reviewer asks "what does this PR still need before I can merge it?"
- User invokes `/qv-devops-why-my-pr-not <PR URL>`

**Do NOT use when:**

- Reviewing a PR for correctness — use [`/qv-devops-pr-review`](../qv-devops-pr-review/SKILL.md) or [`/qv-pr-review`](../qv-pr-review/SKILL.md).
- Generating a PR description — use [`/qv-devops-pr-create`](../qv-devops-pr-create/SKILL.md) or [`/qv-sdk-pr-create`](../qv-sdk-pr-create/SKILL.md).
- Listing all open PRs in the pod — use [`/qv-devops-pr-status`](../qv-devops-pr-status/SKILL.md) or [`/qv-sdk-pr-status`](../qv-sdk-pr-status/SKILL.md).

## Inputs

- **Required**: PR URL or `<owner>/<repo>#<num>` shorthand (defaults `owner/repo` to `tetherto/qvac` if only `#<num>` is given).
- **Optional**: focus hint — `--ci`, `--merge`, or `--both` (default `--both`).

If the PR identifier is missing, ask once. Nothing else to ask up-front.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`). The token needs `repo` scope to read PR metadata, checks, and reviews on `tetherto/qvac`.
- `read:org` is **not** required by the skill itself. If privileged fork jobs fail while recording `qvac/fork-verified`, check `fork-approval` logs — the gate job uses `github.token` with `statuses: write` (not `PAT_TOKEN`).

The skill does not require a checked-out worktree. All inspection is via `gh`.

## Safety rules

This skill follows the repository [working agreement](../../../AGENTS.md#working-agreement): read-only by default, with each remote mutation requiring explicit user authorization.

- **Read-only with respect to the user's local working tree.** No `git switch`, `git checkout`, `git reset`, `git restore`, `git stash`, `git pull`, `git merge`, `git rebase`, `git cherry-pick`, `git clean`, `gh pr checkout`, or any write inside the user's working tree.
- **Read-only with respect to the PR's GitHub state by default.** No `gh pr edit`, no `gh api ... -X POST/PATCH/PUT/DELETE`, no `gh pr comment`, no `gh pr review` without explicit user confirmation per call.
- **Mutations are plan-then-apply.** When the diagnosis suggests a fix that the user could perform (apply a label, post `/review`, request re-review from a teammate, rebase to drop a merge conflict), print the exact `gh` command, wait for the user to type "yes" / "go" / "apply", then execute. A blanket "do everything" is not accepted — confirm per command.
- **Never approve the `fork-ci` environment on the user's behalf.** That gate is intentionally not self-service. The skill may *suggest* who to ask (merge/release team), never click approve for them.

## Efficiency rules

Cap at **6 shell calls** for a normal diagnosis. Cache fetched data once per invocation under `/tmp/why-pr-<num>-<short-sha>.json` so repeat queries within the same session do not re-hit GitHub.

| Call | Purpose |
|---|---|
| 1 | `gh pr view <num> --json number,title,state,isDraft,labels,author,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,latestReviews` |
| 2 | `gh pr checks <num> --json name,state,conclusion,workflow,link` (or `gh api .../check-runs?head_sha=<sha>` if `gh pr checks` is unavailable) |
| 3 | `gh api repos/<owner>/<repo>/commits/<sha>/status` when commit statuses are not present in the PR check rollup |
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

These are short. Read them in full. **Quote them in findings**, do not paraphrase from memory — the rules drift over time and the doc is authoritative.

Read [`check-approvals.yml`](../../../.github/workflows/check-approvals.yml) when an approval finding is triggered rather than relying on remembered thresholds.

For pod ownership, read [`.github/teams/devops.json`](../../../.github/teams/devops.json) / [`.github/teams/sdk.json`](../../../.github/teams/sdk.json) on demand when computing "who can approve fork-ci" or "who is in your CODEOWNERS path."

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

If a required commit status is not represented in the check rollup, use one more call:

```bash
gh api "repos/<owner>/<repo>/commits/<headRefOid>/status"
```

### 4. Run the CI-not-running diagnosis (`--ci` / `--both`)

Walk down this checklist in order. Stop at the first match per dimension; print all matches across the checklist.

| # | Symptom (from PR JSON / checks JSON) | Diagnosis | Cite |
|---|---|---|---|
| C1 | PR `isDraft == true` AND a workflow has `pull_request: types: [opened, synchronize, reopened]` (default) | Draft PRs do not fire `pull_request` events for `ready_for_review` excluded triggers. Mark the PR as ready or push a new commit. | GitHub default `pull_request` event semantics |
| C2 | Workflow runs are present but jobs gated on `needs: fork-approval` are WAITING / pending environment approval | External fork PR: a merge/release-team member must approve the `fork-ci` environment for this run (GitHub UI → pending deployment). Each new push re-prompts. | `docs/ci/LABELS.md` (fork-ci) |
| C3 | Same jobs SKIPPED after approval, AND `qvac/fork-verified` commit status is missing or not `success` for `headRefOid` | `fork-approval` should record `qvac/fork-verified` on the head SHA after env approval via `github.token` (`statuses: write`). If missing, check `fork-approval` job logs. Self-hosted `pull_request` jobs (e.g. `pr-test-inference-addon-cpp*`) read this status, not labels. | `docs/ci/LABELS.md` |
| C4 | PR is from a fork AND privileged jobs ran without env approval (should not happen post label-gate retirement) | Report to DevOps — privileged fork jobs must `needs: fork-approval`. | `ci-trust-policy.test.mjs` |
| C5 | PR is from a fork (`headRepositoryOwner.login != tetherto`) AND only secret-bearing jobs are missing | Expected until `fork-ci` is approved for the current SHA. Unprivileged `pull_request` fork jobs stay read-only (no secrets). | `docs/ci/LABELS.md` |
| C6 | An expensive validation workflow is missing AND PR is an external fork AND `fork-ci` not yet approved for current SHA | Ask merge/release team to approve the pending `fork-ci` deployment on the latest workflow run. Do not recommend the retired `verified` label. | `docs/ci/LABELS.md` |
| C7 | `pr-checks-sdk-pod.yml` jobs are skipped AND PR touches `packages/sdk/` from a fork AND `safe-to-test` is missing | SDK pod's check-running gate. Reviewer must apply `safe-to-test` after auditing the diff. | `LABELS.md § safe-to-test` |
| C8 | E2E suite did not run AND PR touches SDK AND neither `test-e2e-smoke` nor `test-e2e-full` is present | SDK E2E is opt-in via these labels. Apply the smoke variant for normal PR feedback. | `LABELS.md § test-e2e-smoke / test-e2e-full` |
| C9 | A workflow run is FAILED in `fork-approval` (red, not waiting) | Hard misconfiguration — usually missing `statuses: write` on the gate job or failure recording `qvac/fork-verified`. DevOps issue. | `fork-approval` job logs |
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
| M6 | `Check Approvals` failed or its latest comment reports missing approvals | Read the workflow and bot output for the current deficit; do not infer historical tier rules. | `.github/workflows/check-approvals.yml` |
| M7 | A required check (per `statusCheckRollup`) is FAILED | The required check must pass. Link to the failed run; if it's flake, re-run; if it's a real failure, fix. | `gh pr checks` |
| M8 | A required check is missing entirely from `statusCheckRollup` | Either the gating workflow is skipping/waiting (loop back to the CI section — usually fork-ci pending) OR a required check name in branch protection no longer matches a real job (DevOps issue). | branch-protection ruleset |
| M9 | Base branch protection updated mid-PR (new required check added) | Push an empty commit (`git commit --allow-empty`) to re-trigger checks against the new ruleset. | n/a |
| M10 | All checks green, all approvals satisfied, `mergeable: "MERGEABLE"`, `mergeStateStatus: "CLEAN"` | Nothing is blocking. Print "ready to merge" and the merge command the user can run themselves (do not run it). | n/a |

When suggesting reviewers, use current CODEOWNERS and team files for the touched
paths. Do not infer reviewers from an obsolete tier model.

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

**Never propose** approving the `fork-ci` environment on the user's own PR. If privileged fork jobs are waiting, the suggestion is "ask a merge/release-team member to approve the pending `fork-ci` deployment" — not "I'll approve it for you."

After any mutation, re-run step 3 (single `gh pr view`) and re-render only the section(s) that changed. Print one verification line: `Verified: <label X> now present | reviewers <Y, Z> requested | etc.`

### 8. Stop conditions (fail-stop)

Stop and report (do not guess) when:

- `gh auth status` reports unauthenticated → tell the user to run `gh auth login`.
- The PR JSON returns 404 → wrong number / wrong repo / private repo.
- The skill needs to read branch protection but the user lacks permission (`HTTP 403`) → state the limitation; the merge-blocked diagnosis falls back to "what we can see from PR state alone".
- The diagnosis returns zero findings AND the user clearly believes something is broken → say so; offer to dump the raw PR JSON for the user to inspect.

## Quality checklist

Before printing the final report, verify:

- [ ] Each finding cites a real rule from `docs/ci/LABELS.md`, `docs/ci/TEAMS.md`, `approval-check-worker.yml`, or `CODEOWNERS` — not from memory.
- [ ] Each finding has both a "Rule" (one-line quote) and an "Action" (one concrete step).
- [ ] Suggested approvers come from current CODEOWNERS and team configuration, not memory.
- [ ] No mutation has been executed without an explicit per-command confirmation.
- [ ] `fork-ci` approval was never proposed for self-application.
- [ ] Total `gh` shell calls ≤ 6 for a read-only diagnosis (≤ 8 if a mutation + verification was performed).

## References

- Label catalogue: [`docs/ci/LABELS.md`](../../../docs/ci/LABELS.md)
- Team catalogue: [`docs/ci/TEAMS.md`](../../../docs/ci/TEAMS.md)
- Fork CI trust model: [`docs/ci/LABELS.md`](../../../docs/ci/LABELS.md) (`fork-ci`, `fork-approval`, `qvac/fork-verified`)
- Approval check: [`.github/workflows/check-approvals.yml`](../../../.github/workflows/check-approvals.yml)
- Merge-routing: [`.github/CODEOWNERS`](../../../.github/CODEOWNERS)
- DevOps pod metadata: [`.github/teams/devops.json`](../../../.github/teams/devops.json)
- SDK pod metadata: [`.github/teams/sdk.json`](../../../.github/teams/sdk.json)
- Repository working agreement (mutation policy): [`AGENTS.md`](../../../AGENTS.md#working-agreement)
- Generic PR review skill: [`.agents/skills/qv-pr-review/SKILL.md`](../qv-pr-review/SKILL.md)
- DevOps PR review skill: [`.agents/skills/qv-devops-pr-review/SKILL.md`](../qv-devops-pr-review/SKILL.md)
