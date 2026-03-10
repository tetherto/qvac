---
name: release
description: Release a package to NPM. Validates version bump, changelog, creates release branch, monitors CI, verifies publish.
argument-hint: "<package-name>"
disable-model-invocation: true
---

# Release Package

Release an add-on or SDK package to NPM. Ensures version bump, changelog, release branch, CI pipeline, and npm publish.

## Usage

`/release <package-name>`

Where `<package-name>` is the directory name under `packages/` (e.g., `ocr-onnx`, `qvac-lib-infer-onnx-tts`).

## Workflow

### Step 1: Validate prerequisites

1. Read `packages/$ARGUMENTS/package.json` to get the current version.
2. Compare version against `main`:
   ```bash
   git show main:packages/<package>/package.json
   ```
3. If version is **not bumped** compared to `main`, stop and ask the user to bump the version first.
4. Check that `packages/<package>/CHANGELOG.md` has a section matching the current version (`## [X.Y.Z]`). If missing, run `/addon-changelog` first to generate it, then continue.

### Step 2: Confirm with user

Display a summary and ask for confirmation before proceeding:

```
Release summary:
  Package: <package>
  Version: <version>
  Branch:  release-<package>-<version>
  Target:  NPM (latest tag)

Proceed? (y/n)
```

### Step 3: Create release branch

1. Ensure we're on `main` and up to date:
   ```bash
   git checkout main
   git pull origin main
   ```
2. Create the release branch:
   ```bash
   git checkout -b release-<package>-<version>
   ```
3. Push to origin:
   ```bash
   git push -u origin release-<package>-<version>
   ```

This triggers the `on-merge-<package>.yml` workflow which:
- Runs `release-merge-guard` (validates version bump + changelog)
- Builds prebuilds across platforms
- Publishes to NPM with `latest` tag
- Creates a GitHub release with tag `<package>-v<version>`

### Step 4: Monitor CI pipeline

Use `/loop` to poll the pipeline status every 2 minutes:

```
/loop 2m Check the CI pipeline status for the release branch release-<package>-<version>. Run: gh run list --branch release-<package>-<version> --limit 5. If all runs completed successfully, report SUCCESS and stop. If any run failed, report the failure details. If still running, report progress.
```

### Step 5: Verify npm publish

Once CI completes successfully:

1. Check that the package was published to npm:
   ```bash
   npm view @qvac/<package>@<version> version
   ```
   (Note: some packages may not have the `@qvac/` scope — check `package.json` for the actual package name)

2. Check that the GitHub release was created:
   ```bash
   gh release view <package>-v<version>
   ```

3. Report final status to user:
   ```
   Release complete:
     Package: <npm-package-name>@<version>
     NPM: published
     GitHub Release: <package>-v<version>
     Branch: release-<package>-<version>
   ```

### Step 6: Switch back to main

```bash
git checkout main
```

## Error handling

- If `release-merge-guard` fails: the version or changelog is missing/incorrect. Fix and push again.
- If prebuild jobs fail: check the failing platform logs with `gh run view <run-id> --log-failed`.
- If npm publish fails: check if the version already exists (`npm view`), or if `NPM_TOKEN` is valid.
- If the release branch already exists: ask the user whether to use the existing branch or abort.

## Important notes

- This skill pushes a branch to origin and triggers CI. Confirm with the user before proceeding.
- The on-merge workflow handles everything after the branch push — do not manually publish.
- Release branches are never merged back to main automatically. If main needs the changes, a separate PR is required.
