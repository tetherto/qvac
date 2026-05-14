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

Every step is mandatory. Do **not** ask the user whether to do `CHANGELOG_LLM.md` or
`NOTICE` — they are part of this skill and always run.

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

The script automatically excludes:

- PRs tagged `[skiplog]`.
- **Backmerge PRs** (subjects starting with `Backmerge` or `Merge release …`).
  Backmerges merge a release branch back into main; their content is already
  documented in the release branch's own changelog, so listing them here is noise.
- PRs whose title fails the SDK PR-format validator (these are warned, not silently
  dropped — fix the title and re-run, or surface to the PR author).

For `[mod]` PRs, the script extracts the `Added`/`Updated`/`Removed` model lists
from the PR body and renders them as **indented continuation lines beneath the
bullet** in `CHANGELOG.md` (each section on its own line — never inline as one
giant row). The same filtered lists are written to `models.md`.

The extractor applies two policies (in this order):

1. **Companion entries are dropped.** Companions are auxiliary files that ship
   alongside a primary model but aren't independently usable — vocab files,
   lexicons, raw data shards, metadata blobs. The filter recognises constant
   suffixes (`*_LEX`, `*_VOCAB`, `*_DATA`, `*_METADATA`) **and** any free-form
   description containing the word "companion". Only first-class models reach
   the changelog.
2. **Entry-count suffixes are stripped.** `(N entries)` /
   `(N entries — short note)` decorations are removed from the displayed
   text — readers can follow the `models.md` link for exact counts.

After both filters, each section is trimmed to `MAX_INLINE_MODELS` (currently
**5**) entries, with `(and N more)` for the remainder. Example:

```
- Regenerate model registry. (see PR [#123](...)) - See [model changes](./models.md)
  Added: NMT_Q0F16, NMT_Q4_0 (and 12 more)
  Removed: MARIAN_OPUS_*
```

If after filtering a section is empty, it's omitted. If all sections are empty
the bullet emits with no continuation lines.

When writing the human-readable `CHANGELOG_LLM.md` (Step 4), apply the same
"no informational value" rule manually: skip backmerges, automated bumps, and any
entry whose subject would just repeat what a previous release already said. For
the Models section, mirror the script's policy — keep it concise in the body
(highlight the most notable adds/removes) and defer the full constant list to
the `### Added` / `### Removed` blocks at the bottom.

### Step 4: Generate CHANGELOG_LLM.md (mandatory)

Always run this step. Do not ask the user — it's part of the skill.

After raw changelog files exist, generate the human-readable version at
`packages/<package>/changelog/<version>/CHANGELOG_LLM.md`.

See [references/changelog-llm-format.md](references/changelog-llm-format.md) for the format guide.

After writing the file, re-run the raw generator (or rebuild the root aggregate) so
`packages/<package>/CHANGELOG.md` picks up the new `CHANGELOG_LLM.md` (the aggregator
prefers it over `CHANGELOG.md`). Easiest way: re-run the script from Step 3 — it's idempotent.

### Step 5: Generate `announcement-post.txt` (mandatory)

Always run this step after Step 4. It produces a Slack-ready copy-paste post at
`packages/<package>/changelog/<version>/announcement-post.txt`.

The file is **gitignored** (`packages/*/changelog/*/announcement-post.txt`) — it's a
local working artifact, not a committed deliverable. Never `git add` it.

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name> --generate-announcement-post
```

The script parses `CHANGELOG.md` for the package's current version (from
`package.json`) and emits the Slack template:

- `:qvac: SDK <version> :rocket: NPM Public release` header.
- NPM, GitHub release, and full-changelog tree links.
- `:warning: Breaking Changes` section (with link to `breaking.md`) — only if any
  PR is breaking.
- `Release Date: YYYY-MM-DD`.
- One Slack section per CHANGELOG.md section (`:sparkles: Features`,
  `:electric_plug: API`, `:ladybug: Fixes`, `:package: Models`, `:blue_book: Docs`,
  `:test_tube: Tests`, `:broom: Chores`, `:gear: Infrastructure`).
- Each bullet uses `•`, wraps the PR URL in `<...>` (suppresses Slack unfurl), and
  appends ` :boom: breaking` when the bullet is breaking.
- Sections are capped at `MAX_ANNOUNCEMENT_BULLETS` (currently **10**). The
  `... And much more, see full list in changelog :memo:` line is only added
  when a section has *more than 10* entries; anything 10 or fewer is emitted
  verbatim.
- Footer: `Thanks to everyone on QVAC team :green_heart: :qvac: :green_heart:`.

If the post needs hand-tuning (e.g. the Models section needs custom count summaries
that the parser can't infer), edit the file directly. It's gitignored, so changes
won't pollute the diff.

### Step 6: Update NOTICE file for the target package

After Step 5 completes, run notice-generate for the same `--package` to ensure
its NOTICE file reflects any dependency changes in the release:

```bash
source .env
node .cursor/skills/notice-generate/scripts/generate-notice.js <package-name>
```

Do NOT commit the announcement post (gitignored) and let the user review the rest
before committing.

See `.cursor/skills/notice-generate/SKILL.md` for full details.

## CLI Parameters

| Flag                            | Required | Description                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------------ |
| `--package`                     | Yes      | Package name (e.g., `sdk`)                                         |
| `--base-commit`                 | No       | Initial commit SHA for migration (overrides tag lookup)            |
| `--base-version`                | No       | Version label for base commit (display only)                       |
| `--release-type`                | No       | `minor` or `patch` (auto-detected from package.json version)       |
| `--dry-run`                     | No       | Preview output without writing files                               |
| `--update-root-changelog`       | No       | Rebuild only the root aggregate `packages/<pkg>/CHANGELOG.md`      |
| `--generate-announcement-post`  | No       | Generate `announcement-post.txt` for the package's current version |
| `--version`                     | No       | Override version when used with `--generate-announcement-post`     |

## Output

Generates changelog files in `packages/<package>/changelog/<version>/`:

- `CHANGELOG.md` - Main changelog
- `breaking.md` - Breaking changes detail (if `[bc]` PRs)
- `api.md` - API changes detail (if `[api]` PRs)
- `models.md` - Model changes (if `[mod]` PRs)
- `CHANGELOG_LLM.md` - Human-readable version (always generated, see Step 4)
- `announcement-post.txt` - Slack copy-paste post (always generated, see Step 5,
  **gitignored** — never commit)

Additionally:

- `packages/<package>/CHANGELOG.md` – Aggregated changelog containing all versions (newest → oldest), preferring `CHANGELOG_LLM.md` (human-readable) from each version folder when available, falling back to `CHANGELOG.md`

## Tag Format

Tags follow the pattern: `<package>-v<x.y.z>` and are created on **upstream** (not the fork).

Examples:

- `sdk-v0.8.0` (minor — used as base for next minor release)
- `sdk-v0.8.1` (patch — used as base for next patch release)
- `rag-v2.0.0`

## Quality Checklist

Before completing:

- [ ] Correct package identified
- [ ] Base reference resolved (tag or `--base-commit`)
- [ ] PRs scoped to package path only
- [ ] Changelog files written to correct version directory
- [ ] CHANGELOG_LLM.md generated (mandatory) and follows format guide
- [ ] announcement-post.txt generated (mandatory, gitignored)
- [ ] NOTICE file updated for the target package
- [ ] Root CHANGELOG.md rebuilt from all version folders (and picks up CHANGELOG_LLM.md)
- [ ] Versions sorted in descending semver order
- [ ] No duplicated versions
- [ ] Root file is deterministic (fully regenerated)

## References

- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
- GitFlow: `/gitflow.md`
- PR format: `.cursor/rules/sdk/commit-and-pr-format.mdc`
- LLM changelog format: [references/changelog-llm-format.md](references/changelog-llm-format.md)
- NOTICE generation: `.cursor/skills/notice-generate/SKILL.md`
