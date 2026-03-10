---
name: addon-changelog
description: Generate changelog entries for add-on packages. Use when preparing a release or generating release notes for an addon.
argument-hint: "[package-name]"
---

# Generate Human-Readable Changelog Entries

Generate changelog entries for add-on packages following the add-on release workflow.

## When to use this skill

**Use when:**

- Preparing a release for an add-on package
- User asks to generate release notes or changelog for an add-on
- User invokes `/addon-changelog`

## Workflow

### Step 1: Identify Target Add-on

If the user doesn't specify, ask which add-on package they want to generate a changelog for.

### Step 2: Identify version and changes (mandatory version bump + upstream tag diff)

Identify the full set of changes for the **target add-on package only**, validate the version bump in the target add-on `package.json` against `main`, and compute diff from the previous released tag to `HEAD`:

1. **Find the PR base and head**: The base is `main`. The head is the current branch/commit that the PR will merge.
2. **Read versions**:
   - Read `package.json` from `main` (`prev_version`) and from `HEAD` (`current_version`).
   - **Always compare `package.json` between `main` and `HEAD`.**
3. **Mandatory version bump check**:
   - If the `version` in `package.json` is **unchanged** compared to `main`, **stop and display this exact warning** to the user, substituting `<addon>` with the actual add-on name:

   -----------------------------------
   VERSION BUMP REQUIRED
   The `version` in `packages/<addon>/package.json` is unchanged compared to `main`.
   If this PR includes any changes that must be released in the package, you **must** bump the package version, commit/push it and re-run this command.
   -----------------------------------

4. **Resolve upstream release tag for `prev_version`**:
   - Check addon release workflow tag format in `.github/workflows/create-github-release.yml` (`tag_name`).
   - Use that format to build `upstream_tag` for `prev_version`.
   - The tag pattern currently used is `<short_addon_name>-v<version>` (example: `llamacpp-embed-v0.10.7`)

5. **Compute release diff from upstream tag to PR head (package-scoped)**:
   - Primary range for changelog generation: `upstream_tag...HEAD` (or `upstream_tag..HEAD` for commit listing).
   - Scope all comparisons to the target package path using path filtering:
     - diff scope example: `git diff upstream_tag...HEAD -- packages/<addon>/`
     - commit scope example: `git log upstream_tag..HEAD -- packages/<addon>/`
   - This ensures the changelog is based on changes since the previous released version, up to the latest commit in the PR branch.
   - If `upstream_tag` does not exist locally/remotely, warn clearly and fall back to `main...HEAD`.

6. **Do not include uncommitted changes or untracked files**: If any uncommitted/untracked files are present, ignore them.

The goal is to produce a single, package-scoped change set that reflects what will be released next for the target add-on: from the previous released tag (`prev_version`) to the current PR head (`HEAD`).

### Step 3: Collect PRs included in this release

1. **Extract PR numbers** from commit messages in the package-scoped range `upstream_tag..HEAD -- packages/<addon>/` (or fallback `main...HEAD -- packages/<addon>/` if tag is missing)
   - Look for patterns like `#123`, `(#123)`, or `Merge pull request #123`
2. **For each PR found**, use `gh pr view <number>` to get:
   - PR title
   - PR number
   - PR URL
3. **Filter PRs to package-relevant only**:
   - Keep PRs that actually touch files under `packages/<addon>/`.
   - If needed, verify with `gh pr view <number> --json files` and drop unrelated PRs.
4. **Build a list** of PRs to include in the release notes

### Step 4: Generate changelog entry (single source of truth)

Create or update the matching version section in `CHANGELOG.md` with these guidelines:

### Format Requirements

1. **Version heading**: Use exactly `## [X.Y.Z] - YYYY-MM-DD`
   - `X.Y.Z` must match `package.json` version in `HEAD`
   - Date must be the release date in `YYYY-MM-DD`

2. **Introduction**: Write a brief 2-3 sentence summary of what this release brings

3. **Sections**: Create each section using narrative prose style. Omit a section if there is no information related with it:
   - **Breaking Changes**: Lead with impact, explain what changed and why, provide clear migration steps with before/after code
   - **New APIs**: Describe what's possible now, show practical usage examples
   - **Features**: Explain benefits in user terms, not just what was added
   - **Bug Fixes**: Describe what was broken and how it's fixed
   - **Other**: Summarize briefly
   - Use section headings like `## Breaking Changes`, `## Features`, etc. inside the version block

4. **Pull Requests**: At the end, include a "## Pull Requests" section listing all PRs in this release:
   ```markdown
   ## Pull Requests

   - [#123](https://github.com/tetherto/qvac/pull/123) - PR title here
   - [#124](https://github.com/tetherto/qvac/pull/124) - Another PR title
   ```

5. **Workflow compatibility requirement (mandatory)**:
   - The release workflow extracts the GitHub release body from `CHANGELOG.md` by taking text **after** `## [X.Y.Z] - YYYY-MM-DD` until the next version heading `## [`.
   - Therefore:
     - Keep all release content for a version inside that block.
     - Do not create standalone release notes files.
     - Ensure the version block is non-empty.

6. **Style Guidelines**:
   - Use complete sentences, not bullet fragments
   - Lead with benefits/impact
   - Group related changes together
   - Add context where helpful (why this matters)
   - Keep code examples clean and commented
   - Remove internal jargon, make it accessible
   - **Skip entries with no informational value** — generic entries like "Updated models" or "Bumped dependencies" without specific details should be omitted

### Example

**CHANGELOG.md (excerpt):**
```markdown
## [0.4.0] - 2026-02-18

This release introduces automated GitHub releases and improves mobile test reliability.

## Features

### Automated GitHub Releases

The release process is now automated with enforced changelog entries. When a version bump is detected on merge to main, a GitHub release is automatically created using the matching `CHANGELOG.md` version block.

## Bug Fixes

### Mobile E2E Test Workflow Fix

Fixed an issue where mobile E2E tests would fail when the "On PR Trigger" workflow was manually run via workflow_dispatch.

## Pull Requests

- [#67](https://github.com/tetherto/qvac/pull/67) - Fix mobile E2E tests workflow_dispatch
- [#70](https://github.com/tetherto/qvac/pull/70) - feat: automate GitHub releases with mandatory release notes
```
