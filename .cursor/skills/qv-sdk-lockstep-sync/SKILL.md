# SDK Lockstep Client Sync

Keep lockstep SDK clients aligned with `@qvac/sdk` so a `release-sdk-*` cut
ships the same version on npm (`@qvac/sdk`, `@qvac/bare-sdk`) and PyPI
(`tetherto-qvac-sdk`).

## When to use this skill

**Applies to lockstep clients of `@qvac/sdk` only** (not the agent-stack
cascade: cli / ai-sdk-provider / plugins).

**Use when:**

- User runs `/qv-sdk-lockstep-sync` directly.
- Auto-invoked by `/qv-sdk-changelog` when `--package=sdk`.
- Auto-invoked by `/qv-sdk-pr-create` when the PR diff touches
  `packages/sdk/package.json` version or dependency blocks.
- Manually, anytime `@qvac/sdk`'s `version` (or deps that bare-sdk mirrors)
  changes and you want clients in lockstep before opening a PR.

## Clients

| Client | Package | What sync does |
| --- | --- | --- |
| bare-sdk | `@qvac/bare-sdk` | Mirror `version` + shared dep ranges into `packages/bare-sdk/package.json`, then regenerate NOTICE |
| sdk-python | `tetherto-qvac-sdk` | Regenerate generated client (`SDK_VERSION`, methods, models, …) from the sdk tree |

Neither client gets its own changelog; history lives in `packages/sdk/CHANGELOG.md`.

## What it does NOT do

- Does not open release PRs or publish (see `publish-sdk.yml` + gitflow).
- Does not sync agent-stack packages (`/qv-agent-stack-sync`).
- Does not auto-commit.
- Does not run in CI. CI detects drift (`check:deps-vs-sdk`,
  `packages/sdk-python` `generate.py --check`); this skill is the fix.

## Workflow

### Step 1: Sync `@qvac/bare-sdk` metadata

From the monorepo root:

```bash
node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-bare-sdk.mjs
cd packages/bare-sdk
bun run check:deps-vs-sdk
```

Flags on the script: `--dry-run`, `--check` (exit 1 on drift).

NOTICE regeneration is a **separate** step (needs env tokens):

```bash
source .env
node .cursor/skills/qv-notice-generate/scripts/generate-notice.js bare-sdk
```

See the former bare-sdk-only skill notes in git history for exclusion lists
(`PLUGIN_ADDONS`, `SDK_ONLY_PACKAGES`, opt/peer asymmetry). The script header
in `scripts/sync-bare-sdk.mjs` remains the source of truth for what is mirrored.

### Step 2: Sync `packages/sdk-python` generated client

Requires a venv with gen extras (create once if missing):

```bash
cd packages/sdk-python
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -e ".[gen]"
.venv/bin/python3 scripts/generate.py
.venv/bin/python3 scripts/generate.py --check
```

`SDK_VERSION` is stamped from `packages/sdk/package.json`. Commit any updates
under `packages/sdk-python/src/tetherto/qvac_sdk/_generated/`.

### Step 3: Review and commit

`git status` should show (as applicable):

- `packages/bare-sdk/package.json`
- `packages/bare-sdk/NOTICE`
- `packages/sdk-python/src/tetherto/qvac_sdk/_generated/**`

Commit alongside the originating sdk change. When invoked from
`/qv-sdk-changelog`, this is part of the release commit; when invoked from
`/qv-sdk-pr-create`, part of the PR's last commit.

## When this skill is invoked from another skill

### From `/qv-sdk-changelog`

`/qv-sdk-changelog --package=sdk` calls this skill after NOTICE generation for
sdk. Skip for any other `--package` value.

### From `/qv-sdk-pr-create`

If the PR diff touches `packages/sdk/package.json` `version` /
`dependencies` / `optionalDependencies` / `peerDependencies`, the parent skill
prompts to run this skill first. Opt out with `--no-sync` on the parent skill.

## Quality Checklist

- [ ] `sync-bare-sdk.mjs` reports OK or an apply summary; `check:deps-vs-sdk` passes
- [ ] `packages/bare-sdk/NOTICE` regenerated when bare-sdk deps/version changed
- [ ] `packages/sdk-python` `generate.py --check` passes
- [ ] Staged changes are only lockstep client artifacts (+ originating sdk edits)
- [ ] No CI auto-commits of this skill

## References

- bare-sdk drift check: `packages/bare-sdk/scripts/check-deps-vs-sdk.mjs`
- Python generator: `packages/sdk-python/scripts/generate.py`
- Notice generator: `.cursor/skills/qv-notice-generate/SKILL.md`
- Publish: `.github/workflows/publish-sdk.yml` (npm + PyPI on `release-sdk-*`)
- Changelog / PR skills: `qv-sdk-changelog`, `qv-sdk-pr-create`
