---
name: sdk-pr-create
description: Generate PR descriptions for SDK pod packages following template and format rules.
---

# SDK Pod PR Creation

Generate PR titles and descriptions for SDK pod packages, following the team's template and format rules.

## When to use this skill

**Applies to SDK pod packages** as defined in `.cursor/rules/sdk/sdk-pod-packages.mdc`.

**Use when:**
- Creating a PR for any SDK pod package
- User asks to generate PR description
- User invokes `/sdk-pr-create`

## Workflow

1. Identify base and current branch — note whether the base is `main` or a `release-<pkg>-<x.y.z>` branch
2. Collect commits/diff from `<base>...origin/<branch>`
3. Infer ticket, prefix, and tags from changes (see Inference Strategy)
4. Only ask user for input when inference confidence is low
5. Generate title: `TICKET prefix[tags]: subject`
6. Fill template sections based on changes
7. Validate tag requirements ([bc]/[api]/[mod])
8. Output complete PR description
9. If base is a release branch, chain into the dual-PR flow (see "Release Target Dual-PR Flow" below)

## Inference Strategy

Infer first, ask only if uncertain:

**Ticket number:**
- Extract from branch name pattern: `QVAC-\d+`, `SDK-\d+`
- Extract from commit messages if referenced
- ASK only if no ticket found

**Prefix (feat/fix/doc/test/chore/infra):**
- Extract from branch name prefix: `feat/`, `fix/`, `infra/`, etc.
- Use majority prefix from commit messages
- If no conventional commits, infer from diff:
  - New files/exports → `feat`
  - Bug-related changes → `fix`
  - Only .md files → `doc`
  - Only test files → `test`
- ASK only if mixed signals or unclear

**Tags ([api]/[bc]/[mod]):**
- `[api]`: new exported functions/types in public API
- `[bc]`: removed/changed existing public API signatures
- `[mod]`: changes to model constant definitions
- ASK only if change scope is ambiguous

**Testing section:**
- If test files modified → "Unit tests added/updated for X"
- If no tests → ASK what manual testing was done

## Format References

- **PR title format**: See `.cursor/rules/sdk/commit-and-pr-format.mdc`
- **PR body template**: See `.github/PULL_REQUEST_TEMPLATE/sdk-pod.md`

Fill template sections based on the diff analysis. Delete sections that don't apply.

## Output Format

ALWAYS output the PR in this copy-ready format, even when making corrections:

~~~
## PR Title
```
TICKET prefix[tags]: subject
```

## PR Body
```markdown
**Note**: be concise and prefer bullet points.

## 🎯 What problem does this PR solve?
...
```
~~~

## gh CLI Integration

After generating the PR description, check for `gh` CLI:

1. Check if `gh` is installed: `which gh`
2. Check remotes: `git remote -v` to identify fork (origin) vs upstream
3. If available, ask user: "Create PR now with gh CLI?" [Yes / No / Preview first]
4. If yes, ensure changes are committed and pushed first
5. Create PR with explicit repo/base/head for fork workflows:

```bash
# For fork -> upstream PRs:
gh pr create \
  --repo UPSTREAM_ORG/REPO \
  --base main \
  --head FORK_OWNER:BRANCH \
  --title "TICKET prefix: subject" \
  --body "..."

# Then open in browser:
gh pr view --repo UPSTREAM_ORG/REPO BRANCH --web
```

**Important:** 
- `--web` alone only opens browser for manual creation, does NOT create the PR
- For fork PRs, must specify `--repo`, `--base`, and `--head` explicitly
- Commit and push before creating PR

6. If gh not available, output the copy-ready markdown format above
7. As part of the output, provide a clickable hyperlink (not plain text) to the PR on GitHub.

## Release Target Dual-PR Flow

**Trigger:** the just-created PR's base is `release-<pkg>-<x.y.z>` for any SDK pod package.

When triggered, automatically chain into the `sdk-backmerge` skill so a follow-up PR is also opened against `main` with the same version-bump + changelog metadata. This applies the gitflow.md "Keep main aligned" rule at PR-creation time so nobody has to remember a follow-up step after the release PR merges.

### Steps (after Step 5 of gh CLI Integration above)

1. Capture context for the backmerge:
   - Just-created release PR number and URL
   - Release branch name (`release-<pkg>-<x.y.z>`) and parsed `<pkg>` / `<x.y.z>`
   - Source fork branch (the head of the release PR)
   - Ticket number from the title
2. Invoke the `sdk-backmerge` workflow inline with these inputs (read `.cursor/skills/sdk-backmerge/SKILL.md` and follow it).
3. **Fail-stop policy** — if the backmerge cherry-pick produces a conflict outside `sdk-backmerge`'s auto-resolve list, STOP. Print:
   - The release PR URL (success — PR #1 is open)
   - The current `git status -sb` from the conflicted cherry-pick
   - Resume instructions: `git add <files> && git cherry-pick --continue`, then run `/sdk-backmerge --resume`
4. On success, print **both** PR URLs as clickable hyperlinks, ordered:
   - Release PR (target: `release-<pkg>-<x.y.z>`)
   - Backmerge PR (target: `main`)

### Opt-out

To skip the backmerge for a single run, the user can invoke `/sdk-pr-create --no-backmerge`. The skill still creates PR #1 normally and prints a reminder pointing to `/sdk-backmerge` for later.

## Quality Checklist

Before outputting the PR description, verify:

- [ ] Title follows format: `TICKET prefix[tags]: subject`
- [ ] "What problem" describes user impact, not implementation
- [ ] "How it solves" is high-level approach, not line-by-line
- [ ] Unused sections are deleted
- [ ] `[bc]` tag has BEFORE/AFTER code examples
- [ ] `[api]` tag has usage example
- [ ] `[mod]` tag has Added/Removed models list
- [ ] Description is concise - bullet points, no fluff
- [ ] If base is `release-<pkg>-<x.y.z>`, the dual-PR flow ran (or `--no-backmerge` was set), and both PR URLs are reported

## References

- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
- PR template: `.github/PULL_REQUEST_TEMPLATE/sdk-pod.md`
- Format rules: `.cursor/rules/sdk/commit-and-pr-format.mdc`
- Backmerge skill: `.cursor/skills/sdk-backmerge/SKILL.md`
- GitFlow: `docs/gitflow.md`
