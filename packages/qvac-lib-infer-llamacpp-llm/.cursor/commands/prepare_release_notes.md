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

4. **Do not include uncommitted changes or untracked files**: If any uncommitted/untracked files are present, ignore them, but warn the user.

The goal is to produce a single, combined change set that reflects **what will be merged**: all commits on the PR branch versus `main` only.

## Step 2: Generate Release Notes file

Create `release-notes/vX.Y.Z.md` with these guidelines:

### Format Requirements

1. **Title**: `# QVAC LLM Addon v{VERSION} Release Notes`

2. **Introduction**: Write a brief 2-3 sentence summary of what this release brings

3. **Sections**: Create each section using narrative prose style:
   - **Breaking Changes**: Lead with impact, explain what changed and why, provide clear migration steps with before/after code
   - **New APIs**: Describe what's possible now, show practical usage examples
   - **Features**: Explain benefits in user terms, not just what was added
   - **Bug Fixes**: Describe what was broken and how it's fixed
   - **Other sections**: Summarize briefly

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
### Explicit device selection is now required

Model configuration must now specify the `device` to run on. This removes ambiguous defaults and makes it clear whether inference will execute on CPU or GPU.

**Before:**
```js
const config = {
  gpu_layers: '99',
  ctx_size: '1024'
}

const model = new LlmLlamacpp(args, config)
```

**After:**
```js
const config = {
  device: 'gpu', // or 'cpu'
  gpu_layers: '99',
  ctx_size: '1024'
}

const model = new LlmLlamacpp(args, config)
```
```
