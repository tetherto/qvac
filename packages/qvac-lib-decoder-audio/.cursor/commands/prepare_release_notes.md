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

## Step 2: Generate Release Notes file

Create `release-notes/vX.Y.Z.md` with these guidelines:

### Format Requirements

1. **Title**: `# QVAC Audio Decoder v{VERSION} Release Notes`

2. **Introduction**: Write a brief 2-3 sentence summary of what this release brings

3. **Sections**: Create each section using narrative prose style. Omit a section if there is no information related with it:
   - **Breaking Changes**: Lead with impact, explain what changed and why, provide clear migration steps with before/after code
   - **New APIs**: Describe what's possible now, show practical usage examples
   - **Features**: Explain benefits in user terms, not just what was added
   - **Bug Fixes**: Describe what was broken and how it's fixed
   - **Other**: Summarize briefly

4. **Style Guidelines**:
   - Use complete sentences, not bullet fragments
   - Lead with benefits/impact
   - Group related changes together
   - Add context where helpful (why this matters)
   - Keep code examples clean and commented
   - Remove internal jargon, make it accessible
   - **Do NOT include PR links or references to the original CHANGELOG.md** — this is a standalone document
   - **Skip entries with no informational value** — generic entries like "Updated models" or "Bumped dependencies" without specific details should be omitted

### Example

**release-notes/vX.Y.Z.md:**
```markdown
### Audio format parameter is now required

The `FFmpegDecoder` constructor now requires an explicit `audioFormat` parameter. This removes ambiguous default behavior and ensures consistent decoded output across different use cases.

**Before:**
```js
const decoder = new FFmpegDecoder({
  sampleRate: 16000
})
```

**After:**
```js
const decoder = new FFmpegDecoder({
  audioFormat: 's16le',
  sampleRate: 16000
})
```
```
