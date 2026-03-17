---
name: commit-trace
description: Trace a commit to its published npm versions, including transitive SDK resolution with time-aware accuracy
argument-hint: "<commit-sha>"
disable-model-invocation: true
---

# Commit Trace — Find Where a Commit is Published

Given a commit SHA, determines exactly which npm package versions contain it — both directly and transitively via the SDK. Accounts for publish timestamps to give time-accurate resolution answers.

## Usage

```
/commit-trace <commit-sha>
/commit-trace a1b2c3d
/commit-trace a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
```

## Step 1: Validate the Commit

Verify the commit exists:

```bash
git cat-file -t <sha>
```

If invalid, report and stop.

Show the commit summary for context:

```bash
git log --oneline -1 <sha>
```

## Step 2: Identify Affected Packages

Get the list of files changed by this commit:

```bash
git diff-tree --no-commit-id --name-only -r <sha>
```

Map each changed file path to its package by matching `packages/<dir>/` prefixes.

For each affected directory, read `packages/<dir>/package.json` to get:
- The npm package name (e.g., `@qvac/llm-llamacpp`)
- The current version

Build a list of `(directory, npm-name)` pairs. If no `packages/` files were touched, report "this commit does not affect any publishable package" and stop.

## Step 3: Find Direct Release Versions

For each affected package, find which release tags contain the commit:

```bash
git tag --contains <sha>
```

Filter to tags relevant to this package. Tag naming conventions in this repo:
- `llamacpp-llm-v0.12.1` for `@qvac/llm-llamacpp` (package `qvac-lib-infer-llamacpp-llm`)
- `ocr-onnx-v0.2.0` for `@qvac/ocr-onnx`
- `whispercpp-v0.5.0` for `@qvac/transcription-whispercpp`
- Tags vary per package — match by inspecting existing tags for the package

Also check release branches that contain the commit:

```bash
git branch -r --contains <sha>
```

Filter to `origin/release-*` branches relevant to this package.

From the tags and branches, determine the **earliest version** that contains this commit.

## Step 4: Get npm Publish Timestamps

For each affected package, query npm for all published versions with their timestamps:

```bash
npm view <npm-name> time --json
```

This returns a JSON object like `{"0.12.0": "2026-03-01T...", "0.12.1": "2026-03-10T...", ...}`.

Cross-reference: for the version(s) found in Step 3, get their exact publish dates.

If the commit is NOT in any released version yet, report it as **unreleased** — only on `main` (dev builds) or a feature branch.

## Step 5: Transitive Resolution via SDK

This is the critical step. The SDK (`@qvac/sdk`) depends on addon packages with caret ranges (e.g., `"@qvac/llm-llamacpp": "^0.12.1"`).

For each affected package that the SDK depends on:

### 5a. Find the SDK's version range

Read `packages/sdk/package.json` and find the dependency entry for this package. Note the semver range (e.g., `^0.12.1`).

### 5b. Get all SDK release versions and their publish dates

```bash
npm view @qvac/sdk time --json
```

### 5c. For each SDK version, determine the answer to three questions

For each published SDK version:

1. **Does the SDK's semver range allow the addon version containing the commit?**
   - Read the SDK's `package.json` at that SDK's release tag/branch to get the pinned range
   - Check if the addon version from Step 3 satisfies that range
   - **CRITICAL — 0.x caret semantics**: When the major version is 0, caret (`^`) locks to the minor version, NOT the major. For example:
     - `^0.1.5` → `>=0.1.5 <0.2.0` (will NOT pick up 0.2.0, 0.3.0, etc.)
     - `^0.12.1` → `>=0.12.1 <0.13.0` (will NOT pick up 0.13.0)
     - `^1.2.3` → `>=1.2.3 <2.0.0` (normal behavior for major >= 1)
   - If the range doesn't allow it, the answer is NO regardless of timing. Report that the SDK needs a dependency bump.

2. **Was the addon version published before this SDK version?**
   - Compare publish timestamps from npm
   - If the addon version was published AFTER the SDK version, then even if the range allows it, users who installed the SDK at release time would NOT have gotten this addon version

3. **Would a fresh install TODAY resolve to the addon version?**
   - Check if a newer addon version exists that also satisfies the range
   - The latest version satisfying the range is what npm would resolve today

### 5d. Check lock file (if accessible)

For the SDK's release branch, check if a lock file exists that pins the exact addon version:

```bash
git show origin/release-sdk-<version>:packages/sdk/package-lock.json
```

or

```bash
git show origin/release-sdk-<version>:packages/sdk/npm-shrinkwrap.json
```

If a lock file exists, it tells us exactly what shipped. This is the ground truth.

## Step 6: Generate Report

Present findings in this format:

```
Commit: <sha> "<commit message>"
Date: <commit date>

━━━ Direct Packages ━━━

@qvac/llm-llamacpp
  ✅ Released in: v0.12.2 (published 2026-03-15)
  ⏳ Also in dev: 0.13.0-dev.4 (from main)

@qvac/sdk (files touched directly)
  ❌ Not yet released (latest: v0.7.0, commit is after)

━━━ Transitive via @qvac/sdk ━━━

@qvac/llm-llamacpp v0.12.2 → consumed by SDK:

  @qvac/sdk@0.7.0 (published 2026-03-10, pins "^0.12.1")
    Range allows 0.12.2?  ✅ Yes
    0.12.2 existed at SDK publish time?  ❌ No (published 5 days later)
    Fresh install today resolves to?  0.12.2 ✅
    Lock file shipped with?  0.12.1 ❌
    Verdict: ❌ NOT included at release, ✅ included on fresh install today

  @qvac/sdk@0.8.0 (published 2026-03-20, pins "^0.12.1")
    Range allows 0.12.2?  ✅ Yes
    0.12.2 existed at SDK publish time?  ✅ Yes
    Fresh install today resolves to?  0.12.2 ✅
    Lock file shipped with?  0.12.2 ✅
    Verdict: ✅ included at release AND on fresh install

━━━ Summary ━━━

To guarantee this commit:
  • Direct: install @qvac/llm-llamacpp@>=0.12.2
  • Via SDK: install @qvac/sdk@>=0.8.0 (or sdk@0.7.0 with fresh npm install today)
```

## Step 7: Reverse Lookup Mode (Optional)

If the argument looks like a package@version instead of a SHA (contains `@`):

```
/commit-trace @qvac/sdk@0.7.0
```

Reverse the flow:
1. Find the git tag for that version
2. Find the previous version's tag
3. List all commits between the two tags
4. For each commit, show the one-line summary
5. Group by affected sub-package

## Error Handling

- **Commit not found**: Report "commit SHA not found in this repository"
- **No packages affected**: Report "this commit only touches non-package files (CI, docs, root config)"
- **Package not on npm**: Report "this package has never been published to npm" — it may be internal-only
- **npm registry unreachable**: Fall back to git-only analysis (tags and branches), skip timestamp resolution
- **No SDK dependency**: If the affected package is not a dependency of the SDK, skip the transitive section entirely
