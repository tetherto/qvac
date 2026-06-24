---
name: qv-devops-pr-create
description: Generate PR titles and descriptions for DevOps surfaces (CI/CD, composite actions, automation scripts, IaC) following the devops.md PR template and commit/PR format rule. Use when creating a DevOps PR or invoking /qv-devops-pr-create.
disable-model-invocation: true
---

# DevOps PR Creation

Generate PR titles and descriptions for DevOps changes (CI/CD workflows, composite actions, repo-wide automation scripts, IaC), following the DevOps pod's format rule and PR template.

## When to use this skill

**Applies to PRs whose changes are dominated by paths in [`.github/teams/devops.json`'s `ownedPaths`](.github/teams/devops.json):** `.github/workflows/`, `.github/actions/`, `.github/scripts/`, `scripts/`. Also applies to repo-level configuration changes (`.github/CODEOWNERS`, `.github/dependabot.yml`, top-level Dockerfiles, IaC under top-level `terraform/`, `ansible/`, `k8s/`).

**Use when:**

- Creating a PR for any DevOps change
- User asks to generate a DevOps PR description
- User invokes `/qv-devops-pr-create`

If the touched paths are dominated by a non-DevOps pod (e.g., `packages/sdk/**`), use that pod's `*-pr-create` skill instead. If a PR mixes DevOps + package changes, prefer the package's pod skill and call out the cross-pod touches in the PR body.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- Branch is pushed to a fork (or the upstream when the user has write access to `tetherto/qvac`)
- Local branch tracks the remote being PR'd from

## Workflow

1. Confirm base and current branch — note whether the base is `main` (default) or a `release-*` branch (uncommon for DevOps; treat as user-provided).
2. Collect commits/diff from `<base>...origin/<branch>`.
3. Infer ticket, prefix, and tag from changes (see Inference Strategy).
4. Detect trigger sections (action pinning / permissions / plan-dry-run / breaking) and only ask the user for input when inference confidence is low.
5. Generate title: `TICKET prefix[tag]?: subject`.
6. Fill template sections based on changes and detected triggers.
7. Validate tag requirements (`[bc]`).
8. **Save the assembled PR body to `/tmp/pr-body.md`** so subsequent steps and any `gh pr create` invocation can read it back without re-rendering. Print the body in chat for inspection AND keep the file canonical (the gh-CLI step below reads from it).
9. Print the paste-ready commands alongside the in-chat preview — both for direct paste into the GitHub PR-create form and for clipboard tools:

   ```bash
   pbcopy < /tmp/pr-body.md   # macOS
   xclip -selection clipboard < /tmp/pr-body.md   # Linux
   wl-copy < /tmp/pr-body.md   # Wayland
   ```

10. Optionally create the PR via `gh` (see "gh CLI Integration" below).

## Inference Strategy

Infer first, ask only if uncertain.

**Ticket number:**

- Extract from branch name pattern: `QVAC-\d+`, `SDK-\d+`, etc.
- Extract from commit messages if referenced.
- ASK only if no ticket found (offer `[notask]` as the alternative).

**Prefix (`infra` / `feat` / `fix` / `chore` / `doc` / `test`):**

- Extract from branch name prefix when present (e.g. `infra/`, `fix/`, `chore/`).
- Use majority prefix from existing commit messages.
- If no conventional commits, infer from diff:
  - `.github/workflows/**`, `.github/actions/**`, `.github/scripts/**`, `scripts/**`, IaC files, Dockerfiles, runner config → `infra`
  - New skill / new workflow type / new composite action → `feat`
  - Bug-related changes (commit messages mention "fix", "broken", "regression"; reverts) → `fix`
  - Only `.md` / docs files → `doc`
  - Only test files (`.github/actions/*-test/**`, `*.test.*`, `tests/**`) → `test`
  - Pure dependency bumps / deprecations / lockfile churn → `chore`
- ASK only on mixed signals.

**Tag (`[bc]` / `[notask]` / `[skiplog]` — not combinable):**

- `[bc]` (breaking change) when the diff:
  - Renames a job whose name is referenced by a branch protection ruleset (status check rename)
  - Changes a reusable workflow's `inputs:` / `outputs:` shape (workflow_call signature)
  - Changes a composite action's `inputs:` / `outputs:` shape (`.github/actions/<name>/action.yml`)
  - Changes a `workflow_call` `secrets:` or `permissions:` contract
  - Removes a slash command / public surface from a skill that other teams consume
- `[notask]` (PRs only): when no ticket — minor automation hygiene. Ask the user before applying.
- `[skiplog]`: only when the user explicitly asks (this repo uses `[skiplog]` to opt out of changelog generation; not the default for DevOps).

ASK if `[bc]` is ambiguous.

## Trigger detection (drives required template sections)

Walk the diff before assembling the body. For each trigger detected, the corresponding section is REQUIRED in the PR body.

| Trigger | Detection signal | Required section |
|---|---|---|
| Third-party action added / bumped / repinned | `git diff` shows a `uses: <vendor>/<action>@<sha>` change in any `.github/workflows/**` or `.github/actions/**/action.yml` | "🔐 Action pinning" with before/after SHA + version |
| Top-level or per-job `permissions:` block added / modified / removed | `git diff` shows `^[+-].*permissions:` or `^[+-]\s+(contents|pull-requests|id-token|...)\s*:` | "🛡️ Permissions changes" with scope, before/after, justification |
| State-changing op | Any of: `terraform/**` `*.tf`, `ansible/**` `*.yml`, `k8s/**` `*.yaml`, `gh ruleset edit` invocations, branch-protection patches | "📋 Plan / dry-run output" — paste the plan/diff |
| Breaking change | `[bc]` tag set per Inference Strategy | "💥 Breaking changes" with BEFORE/AFTER YAML blocks |

Sections that are NOT triggered MUST be deleted (per the template's "Delete this section if not applicable" markers).

## Format References

- **PR title format**: see the Validation regex below — `^([A-Z]+-\d+ )?(infra|feat|fix|chore|doc|test)(\[(bc|notask|skiplog)\])?: \S.+$`
- **PR body template**: [.github/PULL_REQUEST_TEMPLATE/devops.md](.github/PULL_REQUEST_TEMPLATE/devops.md)
- **Pod conventions**: [.cursor/rules/devops/main.mdc](.cursor/rules/devops/main.mdc)
- **GHA conventions** (drives "How was it tested?" content): [.cursor/rules/devops/github-actions.mdc](.cursor/rules/devops/github-actions.mdc)

Fill the template based on the diff analysis. Delete sections that don't apply.

## Output Format

ALWAYS output the PR in this copy-ready format, even when making corrections:

~~~
## PR Title
```
TICKET prefix[tag]?: subject
```

## PR Body
```markdown
## 🎯 What problem does this PR solve?
...
```
~~~

## Validation

No `pr-validation-devops.yml` workflow exists yet (the SDK-pod validator is paths-scoped to `packages/<pkg>/`). This skill MUST validate the title client-side before pushing or invoking `gh pr create`. Refuse and ask for correction if any of these fail:

- Title regex: `^([A-Z]+-\d+ )?(infra|feat|fix|chore|doc|test)(\[(bc|notask|skiplog)\])?: \S.+$`
- Lowercase prefix and lowercase subject (sentence case allowed; the first word may be capitalized for proper nouns)
- A ticket prefix (`QVAC-\d+`) is present unless `[notask]` is used
- For `[bc]`: body contains a "💥 Breaking changes" section with BEFORE/AFTER fenced blocks
- For an action-pinning trigger: body contains a "🔐 Action pinning" section
- For a permissions trigger: body contains a "🛡️ Permissions changes" section
- For an IaC/state-changing trigger: body contains a "📋 Plan / dry-run output" section

## gh CLI Integration

After generating the PR description, check for `gh` and offer to create the PR:

1. `which gh` — confirm CLI is installed
2. `git remote -v` — identify whether `origin` is the upstream (`tetherto/qvac`) or a fork
3. Ask the user: "Create PR now with gh CLI?" [Yes / No / Preview first]
4. If yes, ensure changes are committed and pushed first
5. Create PR with explicit base/head; for fork workflows, pass `--repo`, `--base`, `--head`:

```bash
gh pr create \
  --repo tetherto/qvac \
  --base main \
  --head <fork-owner>:<branch> \
  --title "TICKET infra: subject" \
  --body "$(cat /tmp/pr-body.md)"
```

For direct-push workflows (the user has write to `tetherto/qvac`):

```bash
gh pr create \
  --base main \
  --title "TICKET infra: subject" \
  --body "$(cat /tmp/pr-body.md)"
```

6. Print the resulting PR URL as a clickable hyperlink.

**Never run `gh pr create --web`** for this skill — `--web` does not actually create the PR; it only opens the browser. The body we generated would be lost.

## Quality Checklist

Before outputting, verify:

- [ ] Title matches the regex above
- [ ] "What problem" describes operator/user impact, not implementation
- [ ] "How it solves" is high-level approach, not line-by-line
- [ ] "How was it tested?" lists concrete validation steps (`actionlint` clean, `workflow_dispatch` test run, `terraform plan` output, `kubectl diff` output, etc.)
- [ ] Untriggered template sections are deleted
- [ ] `[bc]` body has BEFORE/AFTER YAML blocks
- [ ] Action-pinning trigger → action-pinning section present
- [ ] Permissions trigger → permissions section present
- [ ] State-changing trigger → plan/dry-run section present

## References

- DevOps pod main rule: [.cursor/rules/devops/main.mdc](.cursor/rules/devops/main.mdc)
- GitHub Actions conventions: [.cursor/rules/devops/github-actions.mdc](.cursor/rules/devops/github-actions.mdc)
- Secrets handling: [.cursor/rules/devops/secrets-and-credentials.mdc](.cursor/rules/devops/secrets-and-credentials.mdc)
- PR template: [.github/PULL_REQUEST_TEMPLATE/devops.md](.github/PULL_REQUEST_TEMPLATE/devops.md)
- Pod metadata: [.github/teams/devops.json](.github/teams/devops.json)
