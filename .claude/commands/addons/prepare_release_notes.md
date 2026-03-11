# Generate Human-Readable Release Notes

## Step 1: Identify version **and** changes (mandatory version bump check)

Identify the full set of changes that will land in `main` for the PR, and **validate the version bump in `package.json`** against `main`:

1. **Find the PR base and head**: The base is `main`. The head is the current branch/commit that the PR will merge.
2. **Compare against `main`**:
   - Use a range like `main...HEAD` (or the PR base commit...HEAD) to list commits and diffs.
   - **Always compare `package.json` between `main` and `HEAD`.**
3. **Mandatory version bump check**:
   - If the `version` in `package.json` is **unchanged** compared to `main`, **stop and display this exact warning** to the user:

   -----------------------------------
   ⚠️⚠️⚠️ VERSION BUMP REQUIRED ⚠️⚠️⚠️  
   The `version` in `package.json` is unchanged compared to `main`.  
   If this PR includes any changes that must be released in the package, you **must** bump the package version, commit/push it and re-run this command.
   -----------------------------------

4. **Do not include uncommitted changes or untracked files**: If any uncommitted/untracked files are present, ignore them.

The goal is to produce a single, combined change set that reflects **what will be merged**: all commits on the PR branch versus `main` only.

## Step 2: Collect PRs included in this release

1. **Extract PR numbers** from commit messages in the range `main...HEAD`
   - Look for patterns like `#123`, `(#123)`, or `Merge pull request #123`
2. **For each PR found**, use `gh pr view <number>` to get:
   - PR title
   - PR number
   - PR URL
3. **Build a list** of PRs to include in the release notes

## Step 3: Generate Release Notes file

Create `release-notes/vX.Y.Z.md` with these guidelines:

### Format Requirements

1. **Title**: `# QVAC <package_name_readable> v{VERSION} Release Notes`
   Replace `<package_name_readable>` with a corresponding name, depending on which package the release notes are being generated for:
   - `qvac-lib-decoder-audio`: `Audio Decoder`
   - `qvac-lib-infer-llamacpp-embed`: `Embeddings Addon`
   - `qvac-lib-infer-llamacpp-llm`: `LLM Addon`
   - `qvac-lib-infer-nmtcpp`: `NMT Addon`
   - `qvac-lib-infer-onnx-tts`: `TTS ONNX Addon`
   - `qvac-lib-infer-whispercpp`: `Transcription Whisper Addon`
   - `ocr-onnx`: `OCR Addon`

2. **Introduction**: Write a brief 2-3 sentence summary of what this release brings

3. **Sections**: Create each section using narrative prose style. Omit a section if there is no information related with it:
   - **Breaking Changes**: Lead with impact, explain what changed and why, provide clear migration steps with before/after code
   - **New APIs**: Describe what's possible now, show practical usage examples
   - **Features**: Explain benefits in user terms, not just what was added
   - **Bug Fixes**: Describe what was broken and how it's fixed
   - **Other**: Summarize briefly

4. **Pull Requests**: At the end, include a "## Pull Requests" section listing all PRs in this release:
   ```markdown
   ## Pull Requests

   - [#123](https://github.com/tetherto/qvac/pull/123) - PR title here
   - [#124](https://github.com/tetherto/qvac/pull/124) - Another PR title
   ```

5. **Style Guidelines**:
   - Use complete sentences, not bullet fragments
   - Lead with benefits/impact
   - Group related changes together
   - Add context where helpful (why this matters)
   - Keep code examples clean and commented
   - Remove internal jargon, make it accessible
   - **Skip entries with no informational value** — generic entries like "Updated models" or "Bumped dependencies" without specific details should be omitted

### Example

**release-notes/vX.Y.Z.md:**
```markdown
# QVAC OCR Addon v0.4.0 Release Notes

This release introduces automated GitHub releases and improves mobile test reliability.

## Features

### Automated GitHub Releases

The release process is now automated with enforced release notes. When a version bump is detected on merge to main, a GitHub release is automatically created using the corresponding release notes file.

## Bug Fixes

### Mobile E2E Test Workflow Fix

Fixed an issue where mobile E2E tests would fail when the "On PR Trigger" workflow was manually run via workflow_dispatch.

## Pull Requests

- [#67](https://github.com/tetherto/qvac/pull/67) - Fix mobile E2E tests workflow_dispatch
- [#70](https://github.com/tetherto/qvac/pull/70) - feat: automate GitHub releases with mandatory release notes
```
