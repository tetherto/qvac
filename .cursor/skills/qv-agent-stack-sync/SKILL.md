---
name: qv-agent-stack-sync
description: Update and verify the QVAC coding-agent package stack across @qvac/sdk, @qvac/cli, @qvac/ai-sdk-provider, and @qvac/opencode-plugin. Use when syncing CLI to a newer SDK release, preparing agent-stack package releases, or checking OpenCode / AI SDK provider compatibility.
---

# QVAC Agent Stack Sync

Use this skill to update and verify the release chain:

```text
@qvac/opencode-plugin -> @qvac/ai-sdk-provider -> @qvac/cli -> @qvac/sdk
```

The goal is to make sure OpenCode and AI SDK users resolve the intended SDK fixes through the published package graph, not only through the monorepo workspace.

## References

Read these before changing files:

- `.cursor/rules/sdk/main.mdc`
- `.cursor/rules/sdk/commit-and-pr-format.mdc`
- `.cursor/rules/sdk/sdk-pod-packages.mdc`
- `.cursor/skills/qv-sdk-changelog/SKILL.md`
- `.cursor/skills/qv-sdk-pr-create/SKILL.md`
- `.cursor/skills/qv-sdk-backmerge/SKILL.md`
- `packages/cli/test/AGENT_STACK_E2E.md`
- `packages/cli/README.md` agent-stack and SDK dependency sections
- `packages/ai-sdk-provider/README.md`
- `plugins/opencode/README.md`

## Preflight

1. Start from a clean branch based on latest upstream `main`.
2. Fetch upstream tags and `main`.
3. Inspect local package versions and dependency ranges:

```bash
node -e 'for (const f of ["packages/sdk/package.json","packages/cli/package.json","packages/ai-sdk-provider/package.json","plugins/opencode/package.json"]) { const p=require("./"+f); console.log(f, p.name, p.version, p.dependencies?.["@qvac/sdk"] ?? p.dependencies?.["@qvac/cli"] ?? p.peerDependencies?.["@qvac/cli"] ?? "") }'
```

4. Inspect published versions and ranges:

```bash
npm view @qvac/sdk version
npm view @qvac/cli version dependencies --json
npm view @qvac/ai-sdk-provider version peerDependencies dependencies --json
npm view @qvac/opencode-plugin version dependencies --json
```

5. Verify every published package version has a matching git tag:

```bash
git tag --list "sdk-v*" --sort=-v:refname
git tag --list "cli-v*" --sort=-v:refname
git tag --list "ai-sdk-provider-v*" --sort=-v:refname
git tag --list "opencode-plugin-v*" --sort=-v:refname
```

If npm latest is newer than the latest matching git tag, stop and ask whether to repair the missing tag/release metadata or use an explicit base commit for changelog generation. Do not guess the changelog base.

## Decide the Release Shape

Use semver carefully: `0.x` caret ranges do not cross minor versions.

- If `@qvac/cli` can stay on the same minor line, for example `0.7.0 -> 0.7.1`, upper packages may not need dependency edits if their ranges already allow that patch. Still run fresh-install verification.
- If `@qvac/cli` moves to a new minor, for example `0.7.x -> 0.8.0`, update and release upper packages that reference the old CLI minor:
  - `packages/ai-sdk-provider/package.json` peer range must include the new CLI minor.
  - `plugins/opencode/package.json` direct CLI dependency must point at the new CLI minor.
  - `plugins/opencode/package.json` provider dependency must point at the provider version that allows the new CLI minor.
- If the CLI release includes public OpenAI-compatible API changes, prefer a new CLI minor and use `[api]` in the PR title.
- If the CLI release only widens a dependency range to pick up a lower-layer patch fix, a patch release is usually sufficient.

## Decide Release Timing

After preflight and release-shape analysis, make a recommendation before editing release metadata:

- **Release now: one package** - use when only one package needs a dependency-range bump or fix, and verification can run immediately. Example: CLI patch release that only widens `@qvac/sdk`.
- **Release now: dependency chain** - use when an upper package must change to accept a new lower package minor. Release in order and wait for each npm publish before opening the next package's release PR.
- **Stage changes only** - use when the compatibility changes should land on `main` first, but the user does not want to publish immediately. Do not add version bumps, changelog folders, or NOTICE churn unless the user explicitly asks for a release-ready branch.
- **Prepare release PRs but pause before merge** - use when the package changes and release metadata should be ready for review, but the user wants manual control over when publishing happens.

Recommend **patch** when the package only changes dependency ranges, docs for those ranges, tests, or compatibility verification. Recommend **minor** when the package exposes new public API behavior, changes generated model/catalog surface, changes CLI HTTP behavior, changes plugin/provider runtime behavior, or crosses a `0.x` minor dependency boundary that upper packages must opt into.

If unsure, summarize both options and ask. Do not create release branches, push, or open PRs unless the user asked to release or approved the recommendation.

## File Updates

### CLI

When staging changes only, update dependency/code/docs but leave release metadata alone. When releasing now or preparing release PRs, update:

- `packages/cli/package.json`
  - bump `version`
  - set `dependencies["@qvac/sdk"]` to the intended published SDK range, usually the latest SDK minor such as `^0.14.0`
- `packages/cli/README.md`
  - update any documented committed SDK dependency range
  - keep the workspace/local SDK testing instructions accurate
- `packages/cli/CHANGELOG.md` and `packages/cli/changelog/<version>/`
  - generate through `qv-sdk-changelog --package=cli`
- `packages/cli/NOTICE`
  - regenerate through `qv-notice-generate cli`

Do not commit `packages/cli/package-lock.json` unless it is already tracked on the target branch.

### AI SDK Provider

When staging changes only, update code/docs/ranges needed on `main` but leave release metadata alone. When releasing now or preparing release PRs, update only when the CLI release shape requires it:

- `packages/ai-sdk-provider/package.json`
  - bump `version`
  - extend `peerDependencies["@qvac/cli"]` to include the new CLI minor
- `packages/ai-sdk-provider/README.md` if install or compatibility text changes
- changelog and NOTICE through the SDK pod release tools

Because CLI is an optional peer, provider compatibility verification must install `@qvac/cli` explicitly in the test project.

### OpenCode Plugin

When staging changes only, update code/docs/ranges needed on `main` but leave release metadata alone. When releasing now or preparing release PRs, update only when the CLI or provider release shape requires it:

- `plugins/opencode/package.json`
  - bump `version`
  - update `dependencies["@qvac/cli"]`
  - update `dependencies["@qvac/ai-sdk-provider"]`
- `plugins/opencode/README.md` if install or compatibility text changes
- changelog and NOTICE through the SDK pod release tools

Because the plugin has a direct CLI dependency, a fresh plugin install is the final proof that OpenCode users resolve the intended CLI and SDK versions.

## Verification

Run the package checks from the monorepo root or package directories as appropriate.

### CLI

```bash
cd packages/cli
npm install
npm run lint
npm run build
npm run test:unit
npm run test:e2e
node scripts/check-publish-ready.cjs
```

On release branches, SDK Pod Checks run CLI against both the in-repo SDK and the committed published SDK range. If reproducing locally, run one clean install using the committed dependency and one workspace-linked run via `npm run sdk-source:workspace`.

### AI SDK Provider

```bash
cd packages/ai-sdk-provider
bun install
npm run lint
npm run build
npm run test:unit
```

For managed-mode changes or dependency-release validation, run the opt-in integration test with `@qvac/cli` installed:

```bash
QVAC_INTEGRATION_TEST=1 npm run test:integration
```

### OpenCode Plugin

```bash
cd plugins/opencode
npm install
npm run lint
npm run build
npm run test:unit
```

For host/proxy/startup changes or release validation:

```bash
QVAC_INTEGRATION_TEST=1 npm run test:integration
```

### Fresh Install Resolution

After the lower package is published, prove transitive resolution in a clean temp project:

```bash
tmp=$(mktemp -d)
cd "$tmp"
npm init -y >/dev/null
npm install --no-fund --no-audit @qvac/opencode-plugin@latest
npm ls @qvac/opencode-plugin @qvac/ai-sdk-provider @qvac/cli @qvac/sdk
npm ls --json @qvac/opencode-plugin @qvac/ai-sdk-provider @qvac/cli @qvac/sdk
```

The printed versions must show the intended plugin, provider, CLI, and SDK chain. If the plugin intentionally did not need a new release, install the current plugin version and confirm its existing range resolves the newly published CLI.

## Release Flow

Release in dependency order:

1. `@qvac/sdk` if the required SDK version is not already published.
2. `@qvac/cli`.
3. `@qvac/ai-sdk-provider` if its CLI peer range or managed behavior changed.
4. `@qvac/opencode-plugin` if its direct dependencies or plugin behavior changed.

For each package release, follow the existing release skills instead of inventing a one-off flow:

1. Apply that package's version bump together with its package changes on the release branch or release-prep branch.
2. Use `qv-sdk-changelog --package=<package>` for changelog generation, `CHANGELOG_LLM.md`, announcement-post generation, and NOTICE guidance. Follow that skill's package/tag/base rules exactly, including `--base-commit` / `--base-version` if tag metadata is missing.
3. Use `qv-sdk-pr-create` to create the fork -> `release-<package>-<version>` release PR with the standard SDK pod title/body conventions.
4. Let `qv-sdk-pr-create` chain to `qv-sdk-backmerge`, or run `qv-sdk-backmerge` immediately after the release PR is created, so the version bump, changelog folder, aggregate `CHANGELOG.md`, NOTICE, and any release-only package metadata are brought back to `main`.
5. Confirm npm published the package before releasing the next upper layer.

Every QVAC PR must come from the fork and carry `tier1` and `verified`.

## Completion Report

End with:

- packages released or needing release
- whether the recommendation was release now, prepare release PRs, or stage changes only
- suggested version bump for each package, with patch/minor rationale
- exact dependency ranges before and after
- tests run and whether integration tests were skipped
- fresh-install resolution result
- any missing tag/release metadata that needs cleanup
