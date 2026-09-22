---
name: qv-sdk-changelog
description: Generate changelogs for SDK pod packages using tag-based GitFlow. Use when preparing a release, generating changelog, or creating CHANGELOG_LLM.md.
---

# SDK Changelog Generation

Generate changelogs for SDK pod packages following the monorepo GitFlow.

## When to use this skill

**Applies to SDK pod packages** whose paths are owned by `.github/teams/sdk.json`.

**Use when:**

- Preparing a release for any SDK pod package
- User asks to generate changelog
- User asks to create human-readable/presentable changelog
- User asks to generate CHANGELOG_LLM.md
- User invokes `/qv-sdk-changelog`

## Workflow

Every step is mandatory. Do **not** ask the user whether to do `CHANGELOG_LLM.md` or
`NOTICE` — they are part of this skill and always run.

### Step 1: Identify Target Package

If the user doesn't specify, ask which SDK pod package they want to generate a changelog for.

Package slugs match git tags (`sdk`, `inference`, `cli`, `ai-sdk-provider`, `opencode-plugin`, `openclaw-plugin`, …). Directory resolution (including `plugins/*`) is in `scripts/sdk/package-paths.cjs`.

**`sdk` and `inference` are lockstep on major.minor.** Two changelogs, two
releases, engine first: `--package=inference` for `release-inference-<x.y.z>`,
then `--package=sdk` for `release-sdk-<x.y.z>`. Both notes for the same `x.y.z`
share one **display floor**: the last lockstep version already shipped (patch or
`.0`). `--base-commit` is that version's backmerge on main so the new notes do
not repeat it. Use the same floor on both packages; splitting them (inference
from the previous `.0`, SDK from a later patch) duplicates patch notes and
makes the files disagree.

`--base-commit` is only the generate range, not the full set of notes. See
Step 2 when that floor is a patch.

The SDK is the consumer-facing full notes. `--package=sdk` also scans
`packages/inference` (`CHANGELOG_EXTRA_SCAN_DIRS` in
`scripts/sdk/package-paths.cjs`). The inference changelog is the engine-only
slice of that same set. A patch on either side is one release of its own.

**Working branch (when cutting from a release line):** use
`chore/<pkg>-<x.y.z>-changelog` (e.g. `chore/sdk-0.17.0-changelog`). Do **not**
name the head `release-*`: the cli / ai-sdk-provider / plugin publish
workflows trigger on push to `release-*` and publish to npm. The release cut itself must be
three-part `release-<pkg>-x.y.z`. Full rules live in
`qv-sdk-pr-create` → "Release PR branch naming".

### Step 2: Fetch Tags and Resolve Base

Tags live on the **upstream** remote (tetherto/qvac), not the contributor's fork.
The script fetches from `upstream` first, falling back to `origin`.

**Full-history requirement (fail-stop):** discovery is
`git log <base>..HEAD -- <packagePath>`. Before generating:

1. `git rev-parse --is-shallow-repository` must be `false` (else
   `git fetch --unshallow` / re-clone without `--depth`, then stop).
2. Base must be an ancestor of `HEAD`
   (`git merge-base --is-ancestor <base> HEAD`); otherwise check out the
   release tip / package tag first.

The generator enforces both checks and exits non-zero on failure.

**Nested worktrees:** `unset GIT_DIR GIT_WORK_TREE` before any git or changelog
command, or the generator runs against the parent repo.

**Pick `--base-commit`, then pass it.** Do not run the generator unflagged and
hope auto-detect is right.

- **Lockstep `sdk` + `inference`:** always pass `--base-commit` / `--base-version`
  — the last lockstep ship's backmerge on main, same floor on both packages.
  Never tag auto-detect: `inference-v*` is often not an ancestor of `main`, and
  a minor auto-detects the previous `.0` (repeats already-shipped patch notes).
  When that floor is a `.0`, generate is enough. When it is a **patch**, generate
  from the patch backmerge, then union main-only work from the previous lockstep
  `.0` backmerge → that patch backmerge: first-parent merges touching
  `packages/inference` or `packages/sdk`, minus `[skiplog]`, minus PR numbers
  already in `packages/sdk/changelog/<patch>/CHANGELOG.md`. Hand-add to both
  changelogs (`CHANGELOG.md` and `breaking.md` / `models.md` / `api.md` when the
  PR tag requires them). `--update-root-changelog` only after that.

```bash
git log --first-parent --format='%s' <prev-lockstep-.0-backmerge>..<patch-backmerge>
# keep subjects whose merge diff touches packages/inference or packages/sdk
```

- **Standalone** (cli, plugins, anything not lockstep): omit the flags. The
  generator auto-detects (minor → previous `.0`, patch → highest tag).
  Cutting a patch behind current needs `--base-version` passed explicitly. A
  previous `.0` still includes main-only work in the patch window; drop PR
  numbers already in `changelog/<patch>/` if they re-list. If no tags exist,
  ask for `--base-commit` and `--base-version`.

`--base-commit` is only the generate range. The published-version audit after
generate is the consumer delta, for every package.

### Step 3: Generate Raw Changelog

Lockstep (`sdk` / `inference`) always passes the floor from Step 2:

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name> --base-commit=<sha> --base-version=<version>
```

Standalone packages can omit the flags (auto-detect):

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name>
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
giant row). It also writes `models.md`.

`CHANGELOG.md` inline lines may stay at `MAX_INLINE_MODELS` (5) plus
`(and N more)`. **`models.md` is the full added/removed set** — never truncated.
PR bodies are often incomplete; if the published-version audit disagrees, replace
`models.md` from the export/constant diff, not from the PR body.

If this package's public API *is* those exported constants, removed names are
breaking: they go in `breaking.md` even when the PR was only `[mod]`.

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

### After generate: published-version audit (mandatory)

`git log <base>..HEAD` is the generate range. It is not the consumer delta.

For **every** SDK pod package, after the raw files exist:

```bash
DIR=$(node -e "console.log(require('./scripts/sdk/package-paths.cjs').getPackageDir('<slug>'))")
PKG=$(node -e "console.log(require('./${DIR}/package.json').name)")
LAST=$(npm view "$PKG@<base-version>" gitHead)
git diff "$LAST" HEAD -- "$DIR"
```

`<base-version>` is Step 2's `--base-version` (the version this cut supersedes).
Do not `npm view "$PKG" version`: that is dist-tag `latest`, which is a
different line when you cut a patch behind current.

`sdk-v*` tags are not the published commit (`create-github-release.yml` omits
`target_commitish`, so the tag lands on `main`). `gitHead` is packed with the
tarball. Fail-stop if `npm view` cannot resolve. Diff `$DIR`, not
`package.json`: `exports`, serve/HTTP routes, and exported constants live in
source. Every user-facing add, remove, or rename in that diff must appear in
`api.md`, `breaking.md`, and/or `models.md`. Hand-add.
`--update-root-changelog` only — do not re-run a full generate. New public
exports under an older umbrella PR still get their own `api.md` example.

Fail-stop until the notes match the tree. Then write `CHANGELOG_LLM.md`.

### Step 4: Generate CHANGELOG_LLM.md (mandatory)

Always run this step. Do not ask the user — it's part of the skill.

Author `CHANGELOG_LLM.md` from `changelog/<version>/` **after** the published-version
audit, not from `git log`. Title and NPM line are this package (`@qvac/<pkg>`),
not always sdk.

See [references/changelog-llm-format.md](references/changelog-llm-format.md).

Skip backmerges, automated bumps, and entries that only repeat a previous
release. Models body stays concise; the full constant lists live in `models.md`
and in the LLM `### Added` / `### Removed` blocks.

After writing the file, rebuild the root aggregate so
`packages/<package>/CHANGELOG.md` picks up `CHANGELOG_LLM.md` (the aggregator
prefers it over `CHANGELOG.md`):

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name> --update-root-changelog
```

Do **not** re-run a full generate after the published-version hand edits — that
overwrites `api.md` / `breaking.md` / `models.md`.

**Format the generated markdown (mandatory).** `CHANGELOG_LLM.md` is authored by
hand here, so it is the file most likely to carry markdown formatting issues that a
committed-file format check would later reject. Every SDK pod package uses prettier
(`format` = `prettier --check .`, `format:fix` = `prettier --write .`) with
`.prettierrc` set to `"prettier-config-holepunch"`. **Never `--no-config`.** CI
(`[inference] format`, `[sdk] format`, …) loads holepunch; `--no-config` or a
different parser (quote style, trailing commas) is the usual red we hit.

`bunx prettier` fails with `Cannot find package 'prettier-config-holepunch'`
when that package is not resolvable, then either skips or formats with a
fallback CI rejects. **Never `--no-config`.** Do not `bun install` in a package
whose range names an unpublished lockstep dep (e.g. sdk waiting on inference) —
run `bunx` from a sibling that already has `node_modules`.

```bash
DIR=$(node -e "console.log(require('./scripts/sdk/package-paths.cjs').getPackageDir('<name>'))")
bunx prettier --check "$DIR/changelog/<version>/**/*.md" "$DIR/CHANGELOG.md"
```

Scope those globs to **this package**. Do not run `changelog/**/*.md` from the
repo root or another package cwd — that walks every historical version folder.

If it reports problems, fix them — `bunx prettier --write` on the same paths, or
`bun run format:fix` — and re-run the check until it passes clean. Do this before
moving on so the release commit carries only prettier-clean markdown.

**Downstream rendering note:** the docs site reads `CHANGELOG_LLM.md`
**verbatim** and inlines it under a `### @qvac/<pkg>` subsection of the
minor series page (one permanent `v<X.Y>.x.mdx` per minor line — see
`docs/website/docs-workflow.md`). Each headline you write becomes a
section header on the public docs site (with two levels of demotion to
fit the nesting), so phrase them as standalone reader-facing prose, not
internal categories. **Keep headings emoji-free** (e.g. `## Breaking
Changes`, not `## 💥 Breaking Changes`) — emoji prefixes leak verbatim
into the public headers; the only allowed emoji is the `📦 **NPM:**`
line. See the format guide for the full rule.

### Step 5: Generate `announcement-post.txt` (mandatory)

Always run this step after Step 4. It produces a Slack-ready copy-paste post at
`packages/<package>/changelog/<version>/announcement-post.txt`.

The file is **gitignored** (`packages/*/changelog/*/announcement-post.txt`) — it's a
local working artifact, not a committed deliverable. Never `git add` it.

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name> --generate-announcement-post
```

The script emits the short Slack template — header + three links + optional
breaking-changes block + footer. Per-section bullet lists are intentionally
omitted; readers follow the full-changelog link for the detail.

Layout:

- `:qvac: SDK <version> :rocket: NPM Public release` header.
- NPM, GitHub release, and full-changelog tree links.
- `:warning: Breaking Changes` section with link to `breaking.md` — emitted
  when `breaking.md` exists (including hand-added catalog-as-API removals).
  File presence, not `[bc]` tags and not CHANGELOG.md.
- Footer: `Thanks to everyone on QVAC team :green_heart: :qvac: :green_heart:`.

If the post needs hand-tuning (e.g. a custom note for a specific release),
edit the file directly. It's gitignored, so changes won't pollute the diff.

### Step 6: Update NOTICE file for the target package

After Step 5 completes, run notice-generate for the same `--package` to ensure
its NOTICE file reflects any dependency changes in the release:

```bash
source .env
node .agents/skills/qv-notice-generate/scripts/generate-notice.js <package-name>
```

If JS `npm install` fails (unpublished lockstep dep, registry miss), **do not
commit** a NOTICE whose JS section is empty. Restore the JS block from `HEAD`
and keep any successful model-scan additions. Models-only packages still update
model attributions against the last published NOTICE.

Do NOT commit the announcement post (gitignored) and let the user review the rest
before committing.

See `.agents/skills/qv-notice-generate/SKILL.md` for full details.

### Step 7: Set the `@qvac/inference` version (only when `--package=sdk`)

`@qvac/sdk` shares a major.minor with the `@qvac/inference` range it depends on,
and `tetherto-qvac-sdk` is generated from `@qvac/sdk` at the same version. An sdk
release sets both and regenerates the Python client (`SDK_VERSION` and the other
`_generated/` outputs). Skip this step for any other `--package` value — an
`--package=inference` release does not touch the SDK.

Read and follow `.agents/skills/qv-sdk-inference-version/SKILL.md` (Steps 1–4).
Short form:

```bash
npm view @qvac/inference@<x.y.z> version
node .agents/skills/qv-sdk-inference-version/scripts/set-inference-version.mjs --engine-version=<x.y.z>

cd packages/sdk-python
.venv/bin/python3 scripts/generate.py
.venv/bin/python3 scripts/generate.py --check
```

`<x.y.z>` is the `@qvac/inference` version this release ships against, already
published. Include sdk-python generated updates in the release commit. The Python
client does not get its own changelog — history lives in `packages/sdk/CHANGELOG.md`.

### Step 8: Generate site docs (only when `--package=sdk`)

Generate the documentation-site API reference and release notes for the new
version **in the same working tree**, so the changelog PR also carries the docs
update. This replaces the old standalone `docs-release.yml` workflow (which
opened a second, separate docs PR). Skip this step entirely for any other
`--package` value — only the SDK release drives the versioned docs site.

Generation is **deterministic**: it runs the existing `docs/website` scripts
(TypeDoc + Nunjucks render + verbatim `CHANGELOG_LLM.md` inlining). No LLM is
involved in producing the API reference or release notes here — Step 4 already
authored `CHANGELOG_LLM.md`, and this step only renders it into the site.

**Prerequisites:**

- `docs/website` dependencies installed (`cd docs/website && npm install`).
- `SDK_PATH` set in `docs/website/.env` pointing at the SDK package root
  (`packages/sdk`, the directory containing `index.ts` and `tsconfig.json`).
  Copy `docs/website/.env.example` to `.env` if it doesn't exist yet.
  `CHANGELOG_REPO_ROOT` defaults to the repo root, so no override is needed
  when running inside the monorepo.

**1. Generate the API reference + release notes (auto-detects minor vs patch):**

```bash
cd docs/website
bun run scripts/release-version.ts <version> --force-extract
```

This is the exact command the old workflow ran. The dispatcher reads the
version and forwards to the minor (`X.Y.0`: generate the new series' MDX at
`reference/{api,release-notes}/v<X.Y>.x.mdx`, rewrite both `index.mdx` shims
to `<include>` the new series file, and rotate the managed alias block in
`public/_redirects` so the new `v<X.Y>.x` URL 301s to the shim canonical)
or patch (`X.Y.Z`, `Z >= 1`: insert the `## vX.Y.Z` section into the target
series' `v<X.Y>.x.mdx`; for `patch-latest`, also mirror the refreshed
description onto the release-notes shim) orchestrator. It writes only:

- `docs/website/content/docs/reference/api/**` (API summary MDX)
- `docs/website/content/docs/reference/release-notes/**` (release notes MDX)
- `docs/website/src/lib/versions.ts` (version-switcher manifest)
- `docs/website/public/_redirects` (**minor only** — the managed
  `# ==== BEGIN latest-series alias (managed) ====` block; patches never
  touch this file)

Those paths are generated here on release. Capability/CLI/config/runtime prose
is `/qv-docs-update` on the feature PR. Do not hand-edit `reference/**`.

**2. Verify the site still builds (mandatory):**

```bash
cd docs/website
npm run build
```

A clean build confirms nothing on the website broke. Treat a build failure as
**fail-stop**: surface the error and do NOT proceed to commit until it's fixed.

**Staging follows the same convention as the other steps.** Like every other
step, this one only generates files — it never runs `git add` or `git commit`.
The three surfaces above are part of the release commit (same as Step 7's
version files: "Include … in the release commit"), and every
generation/build byproduct is gitignored — exactly like Step 5's
`announcement-post.txt` — so a normal `git status` review shows only the
committable files. Let the user review before committing. Generated + gitignored
byproducts (do not `git add` them):

- `docs/website/scripts/api-docs/api-data.json` (written by `release-version.ts`)
- `docs/website/.next/`, `.source/`, `out/`, `dist/` (from `npm run build`)
- `docs/website/next-env.d.ts`
- `packages/sdk/dist/` (from the `prebuild:examples` build step)

See `docs/website/docs-workflow.md` for the full pipeline reference.

## CLI Parameters

| Flag                            | Required | Description                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------------ |
| `--package`                     | Yes      | Package name (e.g., `sdk`)                                         |
| `--base-commit`                 | Lockstep | Generate-range start. Required for `sdk`/`inference`; overrides tag auto-detect |
| `--base-version`                | Lockstep | Display label for that floor                                       |
| `--release-type`                | No       | `minor` or `patch` (auto-detected from package.json version)       |
| `--dry-run`                     | No       | Preview output without writing files                               |
| `--update-root-changelog`       | No       | Rebuild only the root aggregate `packages/<pkg>/CHANGELOG.md`      |
| `--generate-announcement-post`  | No       | Generate `announcement-post.txt` for the package's current version |
| `--version`                     | No       | Override version when used with `--generate-announcement-post`     |

## Output

Generates changelog files in `packages/<package>/changelog/<version>/`:

- `CHANGELOG.md` - Main changelog
- `breaking.md` - Breaking changes (`[bc]` PRs and catalog-as-API removals)
- `api.md` - API changes (`[api]` PRs and published-version export/route diffs)
- `models.md` - Model changes (full set; `[mod]` PRs and constant diffs)
- `CHANGELOG_LLM.md` - Human-readable version (always generated, see Step 4)
- `announcement-post.txt` - Slack copy-paste post (always generated, see Step 5,
  **gitignored** — never commit)

Additionally:

- `packages/<package>/CHANGELOG.md` – Aggregated changelog containing all versions (newest → oldest), preferring `CHANGELOG_LLM.md` (human-readable) from each version folder when available, falling back to `CHANGELOG.md`

When `--package=sdk`, Step 8 also generates the documentation-site surfaces
(commit these alongside the changelog):

- `docs/website/content/docs/reference/api/**` – API reference MDX
- `docs/website/content/docs/reference/release-notes/**` – Release notes MDX
- `docs/website/src/lib/versions.ts` – Version-switcher manifest
- `docs/website/public/_redirects` – **minor releases only** — the managed
  latest-series alias block (delimited by
  `# ==== BEGIN latest-series alias (managed) ====` markers). Patch
  releases never touch this file.

## Tag Format

Tags follow the pattern: `<package>-v<x.y.z>` and are created on **upstream** (not the fork).

Examples:

- `sdk-v0.8.0` (minor — used as base for next minor release)
- `sdk-v0.8.1` (patch — used as base for next patch release)
- `rag-v2.0.0`

## Repeated mistakes

These have gone red on more than one SDK-pod changelog PR. Fix them before
push, and keep this list to things that are cheap to prevent:

- **Prettier is holepunch, not stock.** `.prettierrc` is `"prettier-config-holepunch"`.
  Never `--no-config`. Resolve holepunch from a package that can install; do not
  `bun install` against an unpublished lockstep dep. Quote style and trailing
  commas on `CHANGELOG_LLM.md` are the usual fail.
- **Lockstep: pass the floor.** Never run the generator unflagged for `sdk` /
  `inference`. Same `--base-commit` on both. When that floor is a patch, union
  the Step 2 main-only window. SDK is the consumer set; inference is the engine
  slice.
- **`inference-v*` is often not on `main`.** Use the backmerge SHA, not the tag.
- **Nested worktrees inherit `GIT_DIR`.** `unset GIT_DIR GIT_WORK_TREE` before
  generate/commit/cherry-pick, or you operate on the parent repo.
- **Push the org remote** (`upstream` when that is `tetherto/qvac`), not the
  contributor fork. `git push` with no remote follows `origin`.
- **Do not skip SDK Pod Checks.** Workspace red vs published red is a real
  signal; `[skip-sdk-pod-checks]` is not the changelog fix.
- **Notes vs `--base-version` `gitHead`, not only `git log`.** After generate,
  audit exports / routes / constants against
  `npm view "$PKG@<base-version>" gitHead`. Do not use `sdk-v*` or npm `latest`.
  `git log <base>..HEAD` misses work that is already an ancestor of
  `--base-commit`.
- **NOTICE JS wipe.** A failed `npm install` must not replace the JS section
  with zero deps. Restore JS from `HEAD`; keep successful model-scan adds.

## Quality Checklist

Before completing:

- [ ] Correct package identified
- [ ] Working head (if branched for the release PR) is `chore/<pkg>-<x.y.z>-changelog`, not `release-*`
- [ ] Clone is not shallow (`git rev-parse --is-shallow-repository` → `false`)
- [ ] Base reference resolved (tag or `--base-commit`) and is an ancestor of `HEAD`
- [ ] For lockstep `sdk` + `inference`: both generated with the **same** `--base-commit` / `--base-version` (last lockstep display floor); never unflagged auto-detect; SDK changelog includes the engine slice
- [ ] When that floor is a patch: main-only window unioned in on both changelogs
- [ ] `GIT_DIR` / `GIT_WORK_TREE` unset (or pointed at this worktree) so generate/git did not run in a parent repo
- [ ] PRs scoped to package path only
- [ ] Changelog files written to correct version directory
- [ ] CHANGELOG_LLM.md authored from `changelog/<version>/` after the published-version audit (this package's name on the title/NPM line)
- [ ] Generated markdown is prettier-clean with **prettier-config-holepunch** resolved (never `--no-config`; do not `bun install` against unpublished lockstep deps)
- [ ] announcement-post.txt generated (mandatory, gitignored)
- [ ] Published-version audit done: `npm view "$PKG@<base-version>" gitHead` vs HEAD under `getPackageDir(<slug>)` (`$DIR`, not `package.json`) matches `api.md` / `breaking.md` / `models.md`
- [ ] `models.md` is the full added/removed set (inline `CHANGELOG.md` may still use `(and N more)`); catalog-as-API removals are in `breaking.md`
- [ ] NOTICE updated; JS section not emptied by a failed install
- [ ] When `--package=sdk`: `qv-sdk-inference-version` run (engine version published, sdk version and `@qvac/inference` range sharing a major.minor, sdk-python regenerated), python `generate.py --check` passing
- [ ] When `--package=sdk`: site docs generated via `release-version.ts`, `npm run build` passed, and `git status` shows only `reference/api/**`, `reference/release-notes/**`, `src/lib/versions.ts` (and `public/_redirects` on **minor** releases — the managed latest-series alias block) as committable docs changes (byproducts gitignored)
- [ ] Root CHANGELOG.md rebuilt from all version folders (and picks up CHANGELOG_LLM.md)
- [ ] Versions sorted in descending semver order
- [ ] No duplicated versions
- [ ] Root file is deterministic (fully regenerated)
- [ ] Org remote (`upstream` when that is tetherto/qvac) is the push target, not the fork

## References

- SDK pod ownership: `.github/teams/sdk.json`
- GitFlow and PR format: `docs/gitflow.md`
- LLM changelog format: [references/changelog-llm-format.md](references/changelog-llm-format.md)
- NOTICE generation: `.agents/skills/qv-notice-generate/SKILL.md`
- sdk @qvac/inference version: `.agents/skills/qv-sdk-inference-version/SKILL.md`
- Docs site pipeline (Step 8): `docs/website/docs-workflow.md`
- Release PR branch naming (org `release-*` push / Merge Guard): `.agents/skills/qv-sdk-pr-create/SKILL.md`
