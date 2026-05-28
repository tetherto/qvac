# SDK ↔ bare-SDK Sync

Mirror `@qvac/sdk` → `@qvac/bare-sdk` package metadata so the two lockstep-released packages can't drift.

## When to use this skill

**Applies to the `sdk` ↔ `bare-sdk` pair only.** Not relevant for other SDK pod packages.

**Use when:**

- User runs `/qv-sdk-bare-sdk-sync` directly.
- Auto-invoked by `/qv-sdk-changelog` when `--package=sdk`.
- Auto-invoked by `/qv-sdk-pr-create` when the PR diff touches `packages/sdk/package.json` version or dependency blocks.
- Manually, anytime `@qvac/sdk`'s `version`, `dependencies`, `optionalDependencies`, or `peerDependencies` change and you want to keep `@qvac/bare-sdk` in lockstep before opening a PR.

## What it does

**Scope:** this skill mirrors `packages/sdk/package.json` → `packages/bare-sdk/package.json` only. NOTICE regeneration is a **separate downstream step** the caller runs after sync (see Step 3 below) via `qv-notice-generate bare-sdk`. The two steps are tightly related (every sync run should be followed by a NOTICE refresh) but the script itself never touches NOTICE.

Mirrors the following from sdk's `package.json` into bare-sdk's:

- `version`
- `dependencies` entries (except `PLUGIN_ADDONS` and `SDK_ONLY_PACKAGES`)
- `optionalDependencies` entries that already exist in bare-sdk (version range only)
- `peerDependencies` entries that already exist in bare-sdk (version range only)

Also **prunes** `dependencies` entries that sdk no longer declares. Without this, dropping a dep from sdk leaves bare-sdk with an "extra dep" that fails `check:deps-vs-sdk` and forces a manual cleanup. Prune is scoped to `dependencies` only — `optionalDependencies` / `peerDependencies` extras are by design (bare-sdk omits Expo/Pear/RN/MCP).

## What it does NOT do

- Does not touch `packages/bare-sdk/NOTICE`. Regenerating NOTICE is a separate `qv-notice-generate` invocation (Step 3 below). The script will not silently re-attribute the package — that requires intent and the right env tokens.
- Does not mirror `keywords`, `description`, `repository`, `exports`, `imports`, `files`, `scripts`, `devDependencies`, or `peerDependenciesMeta`. These intentionally diverge between the two packages.
- Does not add new `optionalDependencies` or `peerDependencies` to bare-sdk. bare-sdk's opt/peer shape is intentionally a subset (no Expo/Pear/RN/MCP). The script only updates ranges for entries that already exist.
- Does not add `PLUGIN_ADDONS` (the 10 `@qvac/*` addon packages bare-sdk excludes by design). The exclusion list lives in `packages/bare-sdk/scripts/plugin-addons.mjs` — single source of truth, shared with `check-deps-vs-sdk.mjs`.
- Does not auto-commit. The dev reviews staged changes and commits.
- Does not run in CI. CI's job is detection (`check:deps-vs-sdk`); the skill's job is the fix.

## Workflow

### Step 1: Run the sync script

From the monorepo root:

```bash
node .cursor/skills/qv-sdk-bare-sdk-sync/scripts/sync.mjs
```

The script prints a summary of every change it makes to `packages/bare-sdk/package.json`. If nothing is out of sync, it exits cleanly with `OK: no drift`.

Useful flags:

| Flag        | Behavior                                                                   |
| ----------- | -------------------------------------------------------------------------- |
| `--dry-run` | Print the change summary without writing the file.                         |
| `--check`   | Exit 1 if drift is detected. Useful for ad-hoc validation (not for CI).    |

### Step 2: Verify with the existing drift check

```bash
cd packages/bare-sdk && bun run check:deps-vs-sdk
```

This is bare-sdk's own CI guard (`packages/bare-sdk/scripts/check-deps-vs-sdk.mjs`). It must pass after sync. If it fails, the sync logic and the check have drifted from each other — file an issue.

### Step 3: Regenerate bare-sdk's NOTICE

```bash
source .env
node .cursor/skills/qv-notice-generate/scripts/generate-notice.js bare-sdk
```

`bare-sdk` is included in `FULL_MODEL_LIST_PACKAGES` (see `.cursor/skills/qv-notice-generate/scripts/lib/config.js`) so the generated NOTICE carries the same model attributions (Gemma terms, etc.) as `@qvac/sdk`'s NOTICE. Required because bare-sdk re-exports sdk's compiled output.

See `.cursor/skills/qv-notice-generate/SKILL.md` for prerequisites (`GH_TOKEN`, `HF_TOKEN`, `NPM_TOKEN`).

### Step 4: Review and commit

`git status` should show modifications to:

- `packages/bare-sdk/package.json`
- `packages/bare-sdk/NOTICE`

Inspect the diffs, then commit alongside the originating sdk change. When invoked from `/qv-sdk-changelog`, this is part of the release commit; when invoked from `/qv-sdk-pr-create`, this is part of the PR's last commit.

## When this skill is invoked from another skill

### From `/qv-sdk-changelog`

`/qv-sdk-changelog --package=sdk` calls this skill as its final step (after NOTICE generation for sdk). This ensures every sdk release run leaves bare-sdk in sync.

If the user passes `--package=<other>`, this skill is skipped (it only applies to the sdk ↔ bare-sdk pair).

### From `/qv-sdk-pr-create`

`/qv-sdk-pr-create` checks the PR diff before opening. If it touches `packages/sdk/package.json` and changes `version`, `dependencies`, `optionalDependencies`, or `peerDependencies`, the parent skill prompts the user to run this skill first. Opt out with `--no-sync` on the parent skill.

## Quality Checklist

Before completing:

- [ ] Script reports `OK: no drift` OR prints an apply summary with all expected changes.
- [ ] `bun run check:deps-vs-sdk` passes in `packages/bare-sdk/`.
- [ ] `packages/bare-sdk/NOTICE` regenerated and reviewed (heading reads `@qvac/bare-sdk`, not `@qvac/sdk`).
- [ ] Staged changes contain only `packages/bare-sdk/package.json` and `packages/bare-sdk/NOTICE`.
- [ ] No CI auto-commits or auto-runs of this skill (skill is local-only).

## References

- Existing drift check: `packages/bare-sdk/scripts/check-deps-vs-sdk.mjs`
- Plugin addon exclusion list: `packages/bare-sdk/scripts/plugin-addons.mjs`
- Notice generator: `.cursor/skills/qv-notice-generate/SKILL.md`
- SDK changelog skill: `.cursor/skills/qv-sdk-changelog/SKILL.md`
- SDK PR-create skill: `.cursor/skills/qv-sdk-pr-create/SKILL.md`
- SDK pod packages: `.cursor/rules/sdk/sdk-pod-packages.mdc`
