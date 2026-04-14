---
name: release
description: Release a package to NPM. Validates version bump, changelog, creates release branch, monitors CI, verifies publish.
argument-hint: "<package-name> [base-branch]"
disable-model-invocation: true
---

# Release Package

Release a package to NPM. Ensures version bump, changelog, release branch, CI pipeline, and npm publish.

The package is identified by the `<package-name>` argument, which is the directory name under `packages/` (e.g., `ocr-onnx`, `qvac-sdk`, `qvac-lib-infer-onnx-tts`). The skill reads `packages/<package-name>/package.json` to determine the package type and npm scope.

## Usage

`/release <package-name> [base-branch]`

Where:
- `<package-name>` is the directory name under `packages/` (e.g., `ocr-onnx`, `qvac-lib-infer-onnx-tts`)
- `[base-branch]` is optional — the branch to create the release from. Defaults to `main`. Use this for patches, e.g., `/release ocr-onnx release-ocr-onnx-0.6.0`

## Workflow

### Step 1: Validate prerequisites

1. Read `packages/$ARGUMENTS/package.json` to get the current version and npm package name.
2. Compare version against the latest version published on npm:
   ```bash
   npm view <npm-package-name> version
   ```
3. If the local version is **not higher** than the npm version, stop and ask the user to bump the version first.
4. Check that `packages/<package>/CHANGELOG.md` has a section matching the current version (`## [X.Y.Z]`). If missing, generate it first then continue:
   - For addon packages (native C++): run `/addon-changelog`
   - For SDK pod packages (TypeScript): run `/sdk-changelog`

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

1. Ensure we're on the base branch and up to date:
   ```bash
   git checkout <base-branch>
   git pull origin <base-branch>
   ```
   Where `<base-branch>` is determined in Step 1 (`main` for new releases, `release-<package>-<base-version>` for patches).
2. Create the release branch:
   ```bash
   git checkout -b release-<package>-<version>
   ```
3. Push the release branch to remote (required for workflow dispatch to find the ref):
   ```bash
   git push origin release-<package>-<version>
   ```
4. Trigger the release workflow manually:
   ```bash
   gh workflow run "on-merge-<package>.yml" --repo tetherto/qvac --ref release-<package>-<version>
   ```

This workflow:
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

### Step 6: Verify public access

Verify the published package is publicly accessible without authentication by installing it in a clean temp directory with no npm token:

```bash
# Create a temp directory and install without any auth
TMPDIR=$(mktemp -d)
cd $TMPDIR
echo "registry=https://registry.npmjs.org/" > .npmrc
npm install <npm-package-name>@<version> --ignore-scripts --no-package-lock
```

If the install succeeds, the package is publicly accessible. If it fails with a 401/403, the package may still be private — flag this to the user.

**Sanity checks on the installed package:**

```bash
# Verify the tarball contents look correct
npm pack <npm-package-name>@<version> --pack-destination $TMPDIR
tar tf $TMPDIR/<tarball-filename> | head -20

# Check that key files are present in the installed package:
ls $TMPDIR/node_modules/<npm-package-name>/
# Expected: package.json, README.md, index.js (or similar entry point), prebuilds/ (for addons)

# Verify package.json version matches
node -e "console.log(require('$TMPDIR/node_modules/<npm-package-name>/package.json').version)"
```

Clean up:
```bash
rm -rf $TMPDIR
```

If any check fails, report the issue to the user before proceeding.

### Step 7: Switch back to main

```bash
git checkout main
```

## Error handling

- If `release-merge-guard` fails: the version or changelog is missing/incorrect. Fix and re-trigger the workflow.
- If prebuild jobs fail: check the failing platform logs with `gh run view <run-id> --log-failed`.
- If npm publish fails: check if the version already exists (`npm view`), or if `NPM_TOKEN` is valid.
- If the release branch already exists: ask the user whether to use the existing branch or abort.

## Important notes

- This skill creates a local release branch, pushes it to remote, and triggers CI manually.
- The on-merge workflow handles building and publishing — do not manually publish.
- Release branches are never merged back to main automatically. If main needs the changes, a separate PR is required.
