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

1. Identify base and current branch:
   - **Normal PR** → base is `main`
   - **Release PR** → base is `release-<package>-<version>` (PR is the release commit on the release branch)
   - **Backmerge PR** → base is `main`, head is `release-<package>-<version>` (or a hand-crafted branch with the release-branch artifacts)
2. Collect commits/diff from `<base>...origin/<branch>`
3. Determine PR shape (normal / release / backmerge — see "Release & Backmerge PRs" below)
4. Infer ticket, prefix, and tags from changes (see Inference Strategy)
5. Only ask user for input when inference confidence is low
6. Generate title using the right format for the PR shape
7. Fill template sections based on changes
8. Validate tag requirements ([bc]/[api]/[mod])
9. Output complete PR description

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

## Release & Backmerge PRs

The standard format `TICKET prefix[tags]: subject` covers normal feature/fix PRs. The release flow has two additional PR shapes that follow established conventions in this repo. **Pick the shape first**, then fill in the template.

**Body always uses the same headings.** Regardless of PR shape (normal / release / backmerge), the body MUST use the standard section headings from `.github/PULL_REQUEST_TEMPLATE/sdk-pod.md`:

- `## 🎯 What problem does this PR solve?` (always)
- `## 📝 How does it solve it?` (always)
- `## 🧪 How was it tested?` (delete if not applicable)
- `## 💥 Breaking Changes` (only if `[bc]`)
- `## 🔌 API Changes` (only if `[api]`)
- `## 📦 Models` (only if `[mod]`)

Do NOT invent custom headings like `## Summary`, `## Changes`, `## Why`, or `## Test plan` — they break tooling and reviewer expectations. Map the content of every PR shape onto these standard sections (see "Mapping release/backmerge content onto the template" below).

### Release PR (fork → release branch)

Cuts a new package version onto a `release-<package>-<version>` branch on `tetherto/qvac`. Bumps `package.json` version, adds the per-version changelog folder, and prepends an entry to the aggregated `CHANGELOG.md`. Merging this PR triggers GPR publish.

**Title format:**

- With ticket: `TICKET chore: release <package> <version>`
  - Example: `QVAC-18184 chore: release sdk 0.9.2`
- Without ticket: `chore[notask|skiplog]: release <package> <version>`
  - Example: `chore[notask|skiplog]: release @qvac/infer-base v0.4.1` (#1781)

**Notes:**
- `[skiplog]` is **not** used when the release PR itself is what generates the changelog (it would be self-contradictory).
- Use `[notask]` only when there is no ticket; combine with `[skiplog]` via `|` if both are needed.
- Body should describe what's in the release at a high level, link to the per-version `CHANGELOG.md`, and call out any post-merge actions (npm publish via backmerge, etc.).

### Backmerge PR (release branch → main)

Brings the release artifacts (changelog folder, aggregated `CHANGELOG.md` entry, version bump in `package.json`) from the release branch back into `main` after the package is published. **Should usually be hand-crafted, not a literal `git merge`** — `main` often has progressed past the release branch on dependencies and other files, and a blind merge regresses them.

**Title format:**

- With ticket: `TICKET chore[skiplog]: backmerge release <package> <version>`
  - Examples:
    - `QVAC-18184 chore[skiplog]: backmerge release sdk 0.9.2` (#1857)
    - `QVAC-16776 chore[skiplog]: backmerge release-sdk-0.9.0 — changelog, NOTICE, model registry, and tooling fixes` (#1645)
    - `QVAC-16495 chore[skiplog]: backmerge sdk v0.8.1 release, changelog & NOTICE` (#1301)
- Without ticket: `chore[notask|skiplog]: backmerge release <package> <version>`
  - Examples:
    - `chore[notask|skiplog]: backmerge release sdk v0.8.3` (#1552)
    - `chore[notask]: backmerge release @qvac/cli v0.2.2` (#1076)

**Tag rules:**
- **`[skiplog]` is required** for backmerges — the changelog has already been written on the release branch; main shouldn't generate another entry from this PR.
- `[notask]` is **only** used when there is no ticket. Do **not** combine `[notask]` with a ticket in the title (`QVAC-XXX chore[notask|skiplog]: ...` is wrong).
- The two metadata tags `[notask]` and `[skiplog]` may be combined via `|` (e.g. `[notask|skiplog]`); this is distinct from the rule that content tags `[api]/[bc]/[mod]` cannot be combined.

### Mapping release/backmerge content onto the template

Use the standard sdk-pod headings for every shape. Suggested mapping:

**Release PR:**
- `## 🎯 What problem does this PR solve?` — what's in the release at a high level (single hotfix? feature batch? security patch?), and which downstream consumer has been waiting on it.
- `## 📝 How does it solve it?` — what files change (`packages/<pkg>/package.json` version bump, the new `changelog/<ver>/` folder, the prepended aggregated `CHANGELOG.md` entry), what the merge triggers (GPR publish), and the post-merge follow-up (open the backmerge PR to publish to npm).
- `## 🧪 How was it tested?` — `bun lint`, `bun run build`, `bun test` results; any release-scripts that were run (`generate-changelog-sdk-pod.cjs`, `generate-notice.cjs` for SDK).

**Backmerge PR:**
- `## 🎯 What problem does this PR solve?` — name the published version, link the release PR, state that `main` is currently behind and would otherwise have a hole in its changelog history.
- `## 📝 How does it solve it?` — list the artifacts brought back (changelog folder, aggregated `CHANGELOG.md` entry, `package.json` version), reference the precedent backmerge PR for the previous version so reviewers can compare shape.
- `## 🧪 How was it tested?` — **if hand-crafted, this is where you justify it.** Explain why a literal `git merge` would regress something on `main` (usually a table of `package.json` dependencies that have advanced past the release branch). Confirm the diff touches only the four expected files. Note any post-merge automation (NOTICE regeneration, etc.) that's expected to follow.

### Decision rule (quick reference)

| You are opening… | Base | Title format | Body |
|---|---|---|---|
| A normal feature/fix/doc PR | `main` | `TICKET prefix[tags]: subject` | sdk-pod template |
| A release PR for a new version | `release-<pkg>-<ver>` | `TICKET chore: release <pkg> <ver>` (or `chore[notask|skiplog]: release ...` if no ticket) | sdk-pod template |
| A backmerge PR after publish | `main` | `TICKET chore[skiplog]: backmerge release <pkg> <ver>` (or `chore[notask|skiplog]: backmerge ...` if no ticket) | sdk-pod template |

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

## Quality Checklist

Before outputting the PR description, verify:

- [ ] Title follows format: `TICKET prefix[tags]: subject` (or the release / backmerge variants above)
- [ ] If the PR has a ticket, `[notask]` is **NOT** in the title
- [ ] If the PR is a backmerge, `[skiplog]` is in the title
- [ ] Body uses the standard sdk-pod headings (`## 🎯 What problem...`, `## 📝 How does it solve...`, `## 🧪 How was it tested?`) — no custom headings like `## Summary` / `## Changes` / `## Test plan`
- [ ] "What problem" describes user impact, not implementation
- [ ] "How it solves" is high-level approach, not line-by-line
- [ ] Unused sections are deleted
- [ ] `[bc]` tag has BEFORE/AFTER code examples
- [ ] `[api]` tag has usage example
- [ ] `[mod]` tag has Added/Removed models list
- [ ] Description is concise - bullet points, no fluff

## References

- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
- PR template: `.github/PULL_REQUEST_TEMPLATE/sdk-pod.md`
- Format rules: `.cursor/rules/sdk/commit-and-pr-format.mdc`
