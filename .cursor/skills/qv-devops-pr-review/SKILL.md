---
name: qv-devops-pr-review
description: PR review for DevOps changes — runs the generic /qv-pr-review flow then layers a structured GitHub Actions security audit (action pinning, permissions, OIDC, hardened runner, secrets handling). Use when reviewing a PR that touches DevOps paths or invoking /qv-devops-pr-review.
disable-model-invocation: true
---

# DevOps PR Review

A DevOps-flavored PR review on top of the generic [`/qv-pr-review`](../qv-pr-review/SKILL.md) flow. Adds a deterministic GitHub Actions security audit pass driven by [`.cursor/rules/devops/github-actions.mdc`](../../rules/devops/github-actions.mdc) and [`.cursor/rules/devops/secrets-and-credentials.mdc`](../../rules/devops/secrets-and-credentials.mdc), so DevOps reviewers always see the same checklist of high-risk patterns regardless of the prose style of the diff.

The skill is **a wrapper, not a fork** — the bulk of the review (gitflow, CI, title/body, generic correctness, security) is done by `/qv-pr-review`. This skill layers DevOps-specific findings into the same pending review payload.

## When to use this skill

**Use when:**

- User asks to review a PR whose changes are dominated by DevOps-owned paths (`.github/workflows/`, `.github/actions/`, `.github/scripts/`, `scripts/`, IaC under `terraform/`, `ansible/`, `k8s/`, `Dockerfile*`, `.github/CODEOWNERS`, `.github/dependabot.yml`)
- User invokes `/qv-devops-pr-review` with a PR URL
- Triggered as a follow-up from `/qv-devops-pr-status` after the user picks a PR

If the PR's touched paths are dominated by a different pod, fall back to `/qv-pr-review`. The generic flow already auto-loads the relevant pod's rules.

## Inputs

- **Required**: PR URL (`https://github.com/tetherto/qvac/pull/<num>`)
- **Optional**: user-provided focus notes

If the URL is missing, ask for it. Nothing else to ask up-front.

## Safety rules

Inherits all safety rules from [`/qv-pr-review`](../qv-pr-review/SKILL.md#safety-rules--do-not-touch-the-users-local-repo) verbatim:

- **Read-only with respect to the user's local working tree.** No `git switch`, `git checkout`, `git reset`, `git restore`, `git stash`, `git pull`, `git merge`, `git rebase`, `git cherry-pick`, `git clean`, `gh pr checkout`, or any write inside the user's working tree.
- All file inspection happens in the worktree cache at `~/.cache/qvac-pr-review/pr-<num>/` (managed by `worktree-prepare.mjs`) or via `gh api .../contents/<path>?ref=<sha>` to `/tmp/`.

## Efficiency rules

Inherits the `~5–8 shell-call` budget from `/qv-pr-review`. The DevOps audit pass adds at most **3 additional reads** (Read/Grep/Glob, not shell) per touched workflow/action file. Cache: reuse `/tmp/pr-<num>.json`, `/tmp/pr-<num>.patch`, and the worktree path from the underlying `/qv-pr-review` run.

## Workflow

### 1. Run the generic /qv-pr-review flow up to step 7a (overview)

Read [`.cursor/skills/qv-pr-review/SKILL.md`](../qv-pr-review/SKILL.md) and follow steps 0a → 7a inclusive:

- 0a. Prepare worktree (`worktree-prepare.mjs`)
- 1. Parse PR URL
- 2. Fetch PR metadata
- 3. Gitflow validation
- 4. Read applicable cursor rules — the touched DevOps paths will auto-load `.cursor/rules/devops/main.mdc`, `.cursor/rules/devops/github-actions.mdc`, and `.cursor/rules/devops/secrets-and-credentials.mdc`. (The PR-format spec is intentionally NOT a rule — it lives in the [`devops-pr-create`](../qv-devops-pr-create/SKILL.md) skill, invoked explicitly.)
- 5. Validate PR title + body against the format spec inlined below (DevOps allowed prefixes: `infra`/`feat`/`fix`/`chore`/`doc`/`test`; tags: `[bc]`/`[notask]`/`[skiplog]`; title regex: `^([A-Z]+-\d+ )?(infra|feat|fix|chore|doc|test)(\[(bc|notask|skiplog)\])?: \S.+$`)
- 6. Review dimensions
- 7a. Print risk overview in chat — but **do not yet run step 7b** (the inline-comment selection prompt). The DevOps audit pass in step 2 below contributes additional findings.

### 2. Run the DevOps GitHub Actions security audit

For every `.github/workflows/*.yml` and `.github/actions/**/action.yml` in the patch, perform the checks below using Read/Grep/Glob against the worktree path. Each check that fires becomes a finding with a tier per the table.

| # | Check | Source rule | Finding tier |
|---|---|---|---|
| A1 | Every `uses: <vendor>/<action>@<ref>` is pinned to a 40-char SHA (regex `@[0-9a-f]{40}\b`) with a trailing `# v<ver>` comment. Tag pins (`@v3`, `@main`, branch refs) fail. First-party `./.github/actions/<name>` references are exempt. | github-actions.mdc § Action references | High |
| A2 | Permissions are declared explicitly — either a top-level `permissions:` block, OR every job has its own `permissions:` block. Relying on repo-default permissions fails. | github-actions.mdc § Permissions | High |
| A3 | No occurrence of `permissions: write-all` anywhere in the workflow. | github-actions.mdc § Permissions | High |
| A4 | If the workflow uses `pull_request_target`, none of its jobs check out PR HEAD via `actions/checkout@... ref: ${{ github.event.pull_request.head.sha }}` or `${{ github.head_ref }}`. | github-actions.mdc § Triggers and untrusted input | High |
| A5 | No direct interpolation of `${{ github.event.pull_request.title }}`, `body`, `head_ref`, `commits[*].message`, or any `github.event.*` user-controlled field inside `run:` blocks. They MUST be piped via `env:`. | github-actions.mdc § Triggers and untrusted input | High |
| A6 | If the workflow has `id-token: write`, OIDC is consumed by an auth action (`google-github-actions/auth`, `aws-actions/configure-aws-credentials`, `azure/login`) — not used for token forging that reaches a long-lived credential. | github-actions.mdc § OIDC | Medium |
| A7 | Sensitive workflows (touch secrets, publish artifacts, deploy, or `id-token: write`) run `step-security/harden-runner` as the first step. Missing → finding. | github-actions.mdc § Hardened runners | Medium |
| A8 | No `${{ secrets.X }}` interpolated directly inside a `run:` block. Pass via `env:` or action `with:` instead. | secrets-and-credentials.mdc § Access in workflows | High |
| A9 | No `set -x` / `bash -x` in steps that touch secrets; no `printenv`, `env`, `cat`, or `echo` of a secret value, even for "debugging". | secrets-and-credentials.mdc § Access in workflows | High |
| A10 | Concurrency block is declared. Release/state-mutating workflows have `cancel-in-progress: false`. | github-actions.mdc § Concurrency | Medium |
| A11 | Every job has `timeout-minutes`. Default budget 30; >30 needs a justifying comment. | github-actions.mdc § Failure handling | Low |
| A12 | `continue-on-error: true` is NOT set on Tier-1 checks (lint, format, type-check, security scans, tests). | github-actions.mdc § Failure handling | Medium |
| A13 | Outputs use `$GITHUB_OUTPUT`, never the deprecated `::set-output::`. | github-actions.mdc § Outputs and step IDs | Low |
| A14 | When `actions/cache` is used, cache writes are gated on non-fork triggers (`push` / `workflow_dispatch` / `merge_group`) — not blanket on `pull_request`. | github-actions.mdc § Caching | Medium |
| A15 | Workflow filename matches the existing repo conventions (`on-pr-*.yml`, `on-merge-*.yml`, `on-pr-close-*.yml`, `release-*.yml`, `create-github-release-*.yml`, `prebuilds-*.yml`, `pr-test-*.yml`, `pr-validation-*.yml`, `pr-checks-*.yml`, `integration-*-*.yml`, `reusable-*.yml`, `trigger-reusable-*.yml`). New file with a divergent name → finding. Pre-existing files keep their name unless the PR renames them. | github-actions.mdc § File layout and naming | Low |

For each finding, capture: file, line, the offending excerpt (3-8 lines), the tier, and a one-line "why" pulled from the rule. Write findings into the same chat overview structure that `/qv-pr-review` step 7a uses, under a new sub-heading `### GHA security audit`.

### 3. Re-print the consolidated chat overview

After both passes, re-print the full overview (gitflow / CI / generic-high / generic-medium / GHA-audit / lows / verified) so the user sees one ranked list. Findings retain the deep-link + excerpt rules from `/qv-pr-review` step 7a.

### 4. Run /qv-pr-review steps 7b → 12

Continue with the generic flow:

- 7b. Selection prompt — the multi-select includes BOTH generic findings and GHA-audit findings. Defaults: every High pre-selected (including all GHA-audit Highs); Medium pre-selected; Low opt-in.
- 8. Assemble inline comments from the user-confirmed set
- 9. Pre-flight check
- 10. Show the `gh api ... pulls/<num>/reviews` command, wait for confirmation
- 11. Post on confirmation
- 12. Output the link to the pending review

### 5. Audit summary in chat (after posting)

After the pending review URL is printed, append a single-line audit summary:

```
GHA audit: <H high> / <M medium> / <L low> findings on N workflow files. <K> filed inline; <skipped> skipped per user.
```

This makes audit coverage observable without reading the inline payload.

## Inline comment style for GHA-audit findings

Inherit the comment style from `/qv-pr-review`. Add one DevOps-specific convention: every GHA-audit finding's body MUST cite the rule it traces back to, e.g.:

```markdown
Untrusted input piped directly into shell. Per `.cursor/rules/devops/github-actions.mdc § Triggers and untrusted input`,
this MUST go through an `env:` block — `${{ github.event.pull_request.title }}` lands in the rendered shell verbatim and is exploitable.

```yaml
env:
  PR_TITLE: ${{ github.event.pull_request.title }}
run: |
  echo "$PR_TITLE"
```
```

The cite makes the audit finding auditable: the reviewer can verify the rule still says what the comment claims.

## Quality Checklist

Before posting the pending review, verify:

- [ ] Underlying `/qv-pr-review` workflow ran through step 7a successfully (worktree prepared, gitflow checked, CI checked, rules loaded, title/body validated)
- [ ] GHA-audit pass ran on every changed `.github/workflows/*.yml` and `.github/actions/**/action.yml`
- [ ] Each GHA-audit finding has: file path, post-change line, 3-8 line excerpt at PR head SHA, deep link, tier, rule cite
- [ ] User-confirmed selection from step 7b matches the assembled payload exactly (count + IDs)
- [ ] Audit summary line is printed after step 12

## References

- Generic PR review skill (parent flow): [.cursor/skills/qv-pr-review/SKILL.md](../qv-pr-review/SKILL.md)
- DevOps GHA conventions (audit source): [.cursor/rules/devops/github-actions.mdc](../../rules/devops/github-actions.mdc)
- DevOps secrets handling (audit source): [.cursor/rules/devops/secrets-and-credentials.mdc](../../rules/devops/secrets-and-credentials.mdc)
- DevOps PR-create skill (canonical home for commit / PR-title format): [`devops-pr-create`](../qv-devops-pr-create/SKILL.md)
- Pod metadata: [.github/teams/devops.json](../../../.github/teams/devops.json)
- Worktree manager: [.cursor/skills/_lib/pr-skills/worktree-prepare.mjs](../_lib/pr-skills/worktree-prepare.mjs)
