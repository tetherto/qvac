# Generate PR Description and Create PR

## Step 1: Identify base/head, collect changes, and verify version bump

Identify the PR base/head, collect the full change set from the **remote tracked branch**, and **validate the version bump in `package.json`** against `main`:

1. **Find the PR base and head**: The base is `main` (or the branch configured as default). The head is the current branch.
2. **Collect changes from the remote tracked branch**:
   - Compare `main...origin/<current-branch>` (or the PR base commit...origin/<current-branch>) to list commits and diffs.
   - The rule: only the remote tracked branch is considered.
3. **Mandatory version bump check**:
   - **Always compare `package.json` between `main` and `origin/<current-branch>`.**
   - If the `version` in `package.json` is **unchanged** compared to `main`, **display this exact warning** to the user:

   -----------------------------------
   ⚠️⚠️⚠️ VERSION BUMP MAY BE REQUIRED ⚠️⚠️⚠️
   The `version` in `package.json` is unchanged compared to `main`.
   If this PR includes any changes that must be released in the package, you **must** bump the package version, commit/push it and re-run this command.
   -----------------------------------

   - Still proceed with the next steps

4. **Do not include uncommitted changes or untracked files**: If any uncommitted/untracked files are present, or if there are local-only commits, ignore them and warn the user.
5. If there's a release notes file in `release-notes/` that matches the new version in `package.json`, read it for additional context. If it's missing, warn the user.

The goal is a single combined change set: all commits on the remote tracked branch vs `main`, while ensuring no unwanted changes end up in the PR description.

## Step 2: Generate the PR description

Use `@PULL_REQUEST_TEMPLATE.md` as the template. Fill it in based on the combined change set. If there are additional instructions in the template file, follow them too.

## Step 3: Create the Pull Request

After generating the description:

1. **Detect the target branch**: Use the repository's default branch (usually `main`) as the base.
2. **Get the current branch name**: This is the head branch for the PR.
3. **Generate a PR title**: Create a concise title based on the changes (e.g., "feat: add automated releases" or "fix: resolve mobile test failures").
4. **Create the PR**: Use `gh pr create` to create the pull request with:
   - `--base`: the target branch (main)
   - `--head`: the current branch
   - `--title`: the generated title
   - `--body`: the generated description from Step 2
   - `--label tier1`
   - `--label verify`

5. **Return the PR URL** to the user when complete.

If a PR already exists for this branch, inform the user and provide the existing PR URL instead of creating a duplicate.
