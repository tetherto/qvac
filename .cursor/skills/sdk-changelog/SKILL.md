---
name: sdk-changelog
description: Generate changelogs for SDK pod packages using tag-based GitFlow. Use when preparing a release, generating changelog, or creating CHANGELOG_LLM.md.
---

# SDK Changelog Generation

Generate changelogs for SDK pod packages following the monorepo GitFlow.

## When to use this skill

**Applies to SDK pod packages** as defined in `.cursor/rules/sdk/sdk-pod-packages.mdc`.

**Use when:**

- Preparing a release for any SDK pod package
- User asks to generate changelog
- User asks to create human-readable/presentable changelog
- User asks to generate CHANGELOG_LLM.md
- User invokes `/sdk-changelog`

## Workflow

### Step 1: Identify Target Package

If the user doesn't specify, ask which SDK pod package they want to generate a changelog for.

### Step 2: Fetch Tags and Resolve Base

Tags live on the **upstream** remote (tetherto/qvac), not the contributor's fork.
The script fetches from `upstream` first, falling back to `origin`.

Run `git tag --list "<package>-v*" --sort=-v:refname` to check for existing version tags.

- If tags exist: the script auto-detects the release type from `package.json` version:
  - **Minor/major release** (version ends in `.0`, e.g. `0.9.0`): uses the latest `.0` tag as base (e.g. `sdk-v0.8.0`), skipping patch tags
  - **Patch release** (version ends in non-zero patch, e.g. `0.8.4`): uses the absolute latest tag as base (e.g. `sdk-v0.8.3`)
- If no tags: ask the user for `--base-commit` and `--base-version` (migration scenario)

**Why this matters:** patches ship on separate release branches and get backmerged into main.
Using the latest patch tag as base for a minor release would miss all PRs that landed on main
between the previous minor release and the last backmerge. The correct base for a minor release
is the previous minor's `.0` tag.

### Step 3: Generate Raw Changelog

All SDK pod packages use the same command:

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name>
```

With migration flags:

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name> --base-commit=<sha> --base-version=<version>
```

### Step 4: Generate CHANGELOG_LLM.md (if requested)

After raw changelog files exist, generate the human-readable version.
See [references/changelog-llm-format.md](references/changelog-llm-format.md) for the format guide.

## CLI Parameters

| Flag             | Required | Description                                                        |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `--package`      | Yes      | Package name (e.g., `sdk`)                                         |
| `--base-commit`  | No       | Initial commit SHA for migration (overrides tag lookup)            |
| `--base-version` | No       | Version label for base commit (display only)                       |
| `--release-type` | No       | `minor` or `patch` (auto-detected from package.json version)       |
| `--dry-run`      | No       | Preview output without writing files                               |

## Output

Generates changelog files in `packages/<package>/changelog/<version>/`:

- `CHANGELOG.md` - Main changelog
- `breaking.md` - Breaking changes detail (if `[bc]` PRs)
- `api.md` - API changes detail (if `[api]` PRs)
- `models.md` - Model changes (if `[mod]` PRs)
- `CHANGELOG_LLM.md` - Human-readable version (generated separately via Step 4)

Additionally:

- `packages/<package>/CHANGELOG.md` – Aggregated changelog containing all versions (newest → oldest), preferring `CHANGELOG_LLM.md` (human-readable) from each version folder when available, falling back to `CHANGELOG.md`

## Tag Format

Tags follow the pattern: `<package>-v<x.y.z>` and are created on **upstream** (not the fork).

Examples:

- `sdk-v0.8.0` (minor — used as base for next minor release)
- `sdk-v0.8.1` (patch — used as base for next patch release)
- `rag-v2.0.0`

### Step 5: Update NOTICE file for the target package

After changelog generation completes, run notice-generate for the same `--package` to ensure its NOTICE file reflects any dependency changes in the release:

```bash
source .env
node .cursor/skills/notice-generate/scripts/generate-notice.js <package-name>
```

Do NOT commit — the user will review and commit.

See `.cursor/skills/notice-generate/SKILL.md` for full details.

## Quality Checklist

Before completing:

- [ ] Correct package identified
- [ ] Base reference resolved (tag or `--base-commit`)
- [ ] PRs scoped to package path only
- [ ] Changelog files written to correct version directory
- [ ] If CHANGELOG_LLM.md requested, follows format guide
- [ ] NOTICE file updated for the target package
- [ ] Root CHANGELOG.md rebuilt from all version folders
- [ ] Versions sorted in descending semver order
- [ ] No duplicated versions
- [ ] Root file is deterministic (fully regenerated)

## References

- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
- GitFlow: `/gitflow.md`
- PR format: `.cursor/rules/sdk/commit-and-pr-format.mdc`
- LLM changelog format: [references/changelog-llm-format.md](references/changelog-llm-format.md)
- NOTICE generation: `.cursor/skills/notice-generate/SKILL.md`
