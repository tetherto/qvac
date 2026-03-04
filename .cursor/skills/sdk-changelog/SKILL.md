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

### Step 2: Check for Tags

Run `git tag --list "<package>-v*" --sort=-v:refname` to check for existing version tags.

- If tags exist: proceed normally (latest tag used as base)
- If no tags: ask the user for `--base-commit` and `--base-version` (migration scenario)

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

| Flag             | Required | Description                                             |
| ---------------- | -------- | ------------------------------------------------------- |
| `--package`      | Yes      | Package name (e.g., `qvac-sdk`)                         |
| `--base-commit`  | No       | Initial commit SHA for migration (overrides tag lookup) |
| `--base-version` | No       | Version label for base commit (display only)            |
| `--dry-run`      | No       | Preview output without writing files                    |

## Output

Generates changelog files in `packages/<package>/changelog/<version>/`:

- `CHANGELOG.md` - Main changelog
- `breaking.md` - Breaking changes detail (if `[bc]` PRs)
- `api.md` - API changes detail (if `[api]` PRs)
- `models.md` - Model changes (if `[mod]` PRs)
- `CHANGELOG_LLM.md` - Human-readable version (generated separately via Step 4)

Additionally:

- `packages/<package>/CHANGELOG.md` – Aggregated changelog containing all versions (newest → oldest)

## Tag Format

Tags follow the pattern: `<package>-v<x.y.z>`

Examples:

- `qvac-sdk-v1.0.0`
- `docs-v0.1.0`
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
