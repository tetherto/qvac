---
name: qv-sdk-pr-create
description: Generate PR descriptions for SDK pod packages following template and format rules. Use when creating an SDK pod PR or invoking /qv-sdk-pr-create.
---

# SDK Pod PR Creation

Generate PR titles and descriptions for SDK pod packages, following the team's template and format rules.

## When to use this skill

**Applies to SDK pod packages** as defined in `.cursor/rules/sdk/sdk-pod-packages.mdc`.

**Use when:**
- Creating a PR for any SDK pod package
- User asks to generate PR description
- User invokes `/qv-sdk-pr-create`

## Branch / remote preference

**Preferred path for internal SDK work:** push the head branch to the org repo (`tetherto/qvac`) and open a same-repo PR. Org-branch ready PRs get baseline CI without any fork trust gate. Heavy tiers still opt in via labels (`test-e2e-smoke` / `test-e2e-full`, addon stage labels, etc.). Prefer **Ready for review** over Draft when you want baseline checks to run (drafts run nothing until ready).

**Fallback:** personal-fork → org PRs still work, but a personal fork counts as external. Privileged CI needs a merge/release-team member to approve the `fork-ci` environment on each workflow run for the current head SHA; each new push re-prompts. Do not ask the PR author to self-approve `fork-ci`.

Resolve remotes from `git remote -v`:
- **Org remote** — URL contains `tetherto/qvac` (often named `upstream`, sometimes `origin`)
- **Fork remote** — contributor fork, if present (often named `origin` when org is `upstream`)

In command examples below, `ORG_REMOTE` / `FORK_REMOTE` / `BRANCH` are placeholders — substitute the resolved remote and branch names. Do not run those tokens literally.

## Release PR branch naming (org-branch path)

`publish-sdk.yml` (and sibling publish workflows) run **Release Merge Guard** on
`push` to any `release-*` ref. The guard validates `github.ref_name` — the branch
that was **pushed** — not the PR base. It requires
`release-<pkg>-x.y.z` (three-part semver).

Consequences for release changelog / metadata PRs:

1. **Base (target)** must be exactly `release-<pkg>-<x.y.z>` (e.g. `release-sdk-0.17.0`).
   Short cuts like `release-sdk-0.17` fail the guard on merge/publish. If the cut
   is short-named, STOP and ask a repo admin to rename it to the three-part form
   before relying on publish (protected-branch rename needs admin).
2. **Head (working branch)** must **not** start with `release-` when pushed to the
   org remote. Prefer `chore/<pkg>-<x.y.z>-changelog`
   (e.g. `chore/sdk-0.17.0-changelog`). Names like `release-sdk-0.17.0-changelog`
   trip Release Merge Guard on the helper push and can leave a failing check on
   that commit SHA.
3. GitHub cannot retarget a PR's **head**. To rename a bad head: push the same
   commits under the new name, open a new PR, close the old one, delete the old
   remote head. If the new PR still shows a stale Release Merge Guard fail on the
   same SHA, push an empty `[skiplog]` commit so checks reattach to a fresh SHA.

`backmerge/release-<pkg>-<x.y.z>` heads are fine — they do not match the
`release-*` push trigger.

## Workflow

1. Identify base and current branch — note whether the base is `main` or a `release-<pkg>-<x.y.z>` branch. For release PRs, apply **Release PR branch naming** above (base three-part; head not `release-*`)
2. Resolve the head remote (prefer org remote; see above). Collect commits/diff from `<base>...<head-remote>/<branch>` (or local `HEAD` if not yet pushed)
3. Infer ticket, prefix, and tags from changes (see Inference Strategy)
4. Only ask user for input when inference confidence is low
5. Generate title: `TICKET prefix[tags]: subject`
6. Fill template sections based on changes
7. Validate tag requirements ([bc]/[api]/[mod])
8. **If diff touches the `version` of `packages/sdk` or its `@qvac/inference` range, or sdk's dep blocks**, chain into the `qv-sdk-inference-version` skill (see "SDK @qvac/inference Version Trigger" below)
9. Output complete PR description
10. If base is a release branch, chain into the dual-PR flow (see "Release Target Dual-PR Flow" below)

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
## 🎯 What problem does this PR solve?
...
```
~~~

## gh CLI Integration

After generating the PR description, check for `gh` CLI:

1. Check if `gh` is installed: `which gh`
2. Check remotes: `git remote -v` — identify the **org** remote (`tetherto/qvac`) and any fork remote
3. If available, ask user: "Create PR now with gh CLI?" [Yes / No / Preview first]
4. If yes, ensure changes are committed, then push the head branch to the **org remote** when the user has write access. Only push to a personal fork when org push is unavailable or the user explicitly chooses the fork path
5. Create the PR:

```bash
# Preferred — org-branch (same-repo) PR.
# ORG_REMOTE = remote whose URL is tetherto/qvac (often `upstream` or `origin`).
git push -u ORG_REMOTE BRANCH
gh pr create \
  --repo tetherto/qvac \
  --base main \
  --head BRANCH \
  --title "TICKET prefix: subject" \
  --body "..."

# Fallback — personal fork -> org PR (external CI path; needs merge/release fork-ci approval per run):
git push -u FORK_REMOTE BRANCH
gh pr create \
  --repo tetherto/qvac \
  --base main \
  --head FORK_OWNER:BRANCH \
  --title "TICKET prefix: subject" \
  --body "..."

# Then open in browser:
gh pr view --repo tetherto/qvac BRANCH --web
```

**Important:**
- `--web` alone only opens browser for manual creation, does NOT create the PR
- For fork PRs, must specify `--repo`, `--base`, and `--head FORK_OWNER:BRANCH` explicitly
- For org-branch PRs, `--head BRANCH` (no `owner:`) is enough when `--repo tetherto/qvac`
- Do not add fork trust gates on org-branch PRs; baseline CI runs without them. For fork PRs, tell the user a merge/release reviewer must approve the pending `fork-ci` deployment after reviewing the current head
- Commit and push before creating PR

6. If gh not available, output the copy-ready markdown format above
7. As part of the output, provide a clickable hyperlink (not plain text) to the PR on GitHub.

## SDK @qvac/inference Version Trigger

**Trigger:** the PR diff (`<base>...<head-remote>/<branch>` or local `HEAD`) modifies the `version` of `packages/sdk/package.json` or its `@qvac/inference` range, or sdk's `dependencies` / `optionalDependencies` / `peerDependencies`.

When triggered, prompt the user to run `qv-sdk-inference-version` so the versions and the generated Python client are right in the same commit/PR: `@qvac/sdk`'s version and its `@qvac/inference` range sharing a major.minor, and `tetherto-qvac-sdk` (generated `SDK_VERSION` / `_generated/`) at the SDK's version. A range on a different major.minor fails the SDK's `lint` on every PR.

A change to `packages/inference/package.json` alone is not a trigger — the engine has its own version and its own release.

### Steps (after Step 7 of Workflow above)

1. Detect the trigger condition by inspecting the diff:
   - `git diff <base>...<head-remote>/<branch> -- packages/sdk/package.json` (or vs local `HEAD`) shows changes
   - Changes touch sdk's `version` line, its `@qvac/inference` range, OR sdk's `dependencies` / `optionalDependencies` / `peerDependencies` block
2. If triggered, ask user: "PR touches sdk's deps/version. Run `qv-sdk-inference-version` (version + sdk-python)?" [Yes / No (skip)]
3. If yes, read `.cursor/skills/qv-sdk-inference-version/SKILL.md` and follow it inline.
4. Verify: `bun run enforce-inference-versions` in `packages/sdk` and `packages/sdk-python` `generate.py --check` must both pass.
5. Stage and commit the version changes onto the same branch BEFORE proceeding to Output step.

### Opt-out

To skip this sync for a single run, the user can invoke `/qv-sdk-pr-create --no-sync`. The skill proceeds normally and emits a reminder at the end: "Reminder: sdk deps/version changed but the `@qvac/inference` version was not synced. Run `/qv-sdk-inference-version` before merge."

## Docs Artifacts (SDK Releases)

**Context:** for `@qvac/sdk` releases, the `qv-sdk-changelog` skill (Step 8)
now generates the documentation-site API reference + release notes locally and
ships them in this same release PR. There is **no longer a separate
auto-generated docs PR** (the old `docs-release.yml` workflow was removed).

Staging works the same as for the rest of the release commit — no special
handling is needed. Step 8's three committable surfaces
(`docs/website/content/docs/reference/api/**`,
`docs/website/content/docs/reference/release-notes/**`,
`docs/website/src/lib/versions.ts`) show up in `git status` alongside the
changelog, while every generation/build byproduct
(`api-data.json`, `.next/`, `.source/`, `out/`, `dist/`, `next-env.d.ts`,
`packages/sdk/dist/`) is gitignored and therefore never appears. Review
`git status` and commit the shown files as usual.

Reviewers should expect the `reference/api` + `reference/release-notes` diff in
the release PR alongside the changelog.

## Release Target Dual-PR Flow

**Trigger:** the just-created PR's base is `release-<pkg>-<x.y.z>` for any SDK pod package.

When triggered, automatically chain into the `sdk-backmerge` skill so a follow-up PR is also opened against `main` with the same version-bump + changelog metadata. This applies the gitflow.md "Keep main aligned" rule at PR-creation time so nobody has to remember a follow-up step after the release PR merges.

**Preflight before opening the release PR:** confirm base matches
`^release-<pkg>-\d+\.\d+\.\d+$` and the org head is **not** `release-*`
(see **Release PR branch naming**). Do not open / chain the dual-PR flow against
a short-named cut if publish is expected on merge.

### Steps (after Step 5 of gh CLI Integration above)

1. Capture context for the backmerge:
   - Just-created release PR number and URL
   - Release branch name (`release-<pkg>-<x.y.z>`) and parsed `<pkg>` / `<x.y.z>`
   - Source head branch, org-remote-qualified when possible (e.g. `ORG_REMOTE/<branch>`, or the release PR `headRefOid` if the remote tip is missing)
   - Ticket number from the title
2. Invoke the `sdk-backmerge` workflow inline with these inputs (read `.cursor/skills/qv-sdk-backmerge/SKILL.md` and follow it).
3. **Fail-stop policy** — if the backmerge cherry-pick produces a conflict outside `sdk-backmerge`'s auto-resolve list, STOP. Print:
   - The release PR URL (success — PR #1 is open)
   - The current `git status -sb` from the conflicted cherry-pick
   - Resume instructions: `git add <files> && git cherry-pick --continue`, then run `/qv-sdk-backmerge --resume`
4. On success, print **both** PR URLs as clickable hyperlinks, ordered:
   - Release PR (target: `release-<pkg>-<x.y.z>`)
   - Backmerge PR (target: `main`)

### Opt-out

To skip the backmerge for a single run, the user can invoke `/qv-sdk-pr-create --no-backmerge`. The skill still creates PR #1 normally and prints a reminder pointing to `/qv-sdk-backmerge` for later.

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
- [ ] Generated helper notes, template instructions, and tool footers are removed from the PR body
- [ ] If diff touches sdk's `version` / `@qvac/inference` range (or sdk's deps), `qv-sdk-inference-version` ran (or `--no-sync` was set with a reminder emitted), and the version checks plus sdk-python checks pass
- [ ] For sdk releases with generated docs, `git status` shows only `reference/api/**`, `reference/release-notes/**`, and `src/lib/versions.ts` as committable docs changes — disposable byproducts (`api-data.json`, `out/`, `.next/`, `dist/`, etc.) are gitignored
- [ ] If base is `release-<pkg>-<x.y.z>`, the dual-PR flow ran (or `--no-backmerge` was set), and both PR URLs are reported
- [ ] Release PRs: base is three-part `release-<pkg>-x.y.z`; org head is `chore/<pkg>-<x.y.z>-changelog` (or other non-`release-*` name)
- [ ] Head was pushed to the org remote when write access allows; fork path only used as fallback (with `fork-ci` re-approval called out)
- [ ] PR is Ready for review when baseline CI is expected (not left as Draft unintentionally)

## References

- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
- PR template: `.github/PULL_REQUEST_TEMPLATE/sdk-pod.md`
- Format rules: `.cursor/rules/sdk/commit-and-pr-format.mdc`
- Backmerge skill: `.cursor/skills/qv-sdk-backmerge/SKILL.md`
- sdk @qvac/inference version: `.cursor/skills/qv-sdk-inference-version/SKILL.md`
- GitFlow: `docs/gitflow.md` — still documents fork-first contribution; for internal SDK PRs, prefer the org-branch path in this skill until DevOps updates gitflow
- Fork CI trust model: `docs/ci/LABELS.md` (fork-ci environment + `fork-approval`)
