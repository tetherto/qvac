# CI Validation — Domain Knowledge

Reference for CI specialist sub-agents. Read this before triggering, monitoring, or troubleshooting CI workflows.

## Overview

QVAC CI is **path-scoped**: only workflows matching changed `packages/<pkg>/**` paths run. The repo uses a **fork-first model** — contributors PR from forks into upstream branches. CI runs on `pull_request_target` (not `pull_request`) for addon PRs, which means the workflow definition comes from the base branch.

Workflow files live in `.github/workflows/` and fall into distinct categories by package type.

## Package Types & Their CI Flows

### Native Addons (C++ packages)

Packages: `qvac-lib-infer-llamacpp-llm`, `qvac-lib-infer-llamacpp-embed`, `qvac-lib-infer-onnx-tts`, `qvac-lib-infer-whispercpp`, `qvac-lib-infer-parakeet`, `qvac-lib-infer-nmtcpp`, `qvac-lib-decoder-audio`, `ocr-onnx`

Each addon has a full suite of per-package workflows:

| Workflow | File pattern | Purpose |
|----------|-------------|---------|
| PR checks | `on-pr-<pkg>.yml` | Sanity checks, C++ lint, C++ tests, prebuilds, integration tests, mobile tests |
| Integration tests | `integration-test-<pkg>.yml` | Cross-platform integration tests (7 platforms) |
| Mobile tests | `integration-mobile-test-<pkg>.yml` | Android + iOS on AWS Device Farm |
| Prebuilds | `prebuilds-<pkg>.yml` | Build native bindings for 9 platform targets |
| On merge | `on-merge-<pkg>.yml` | Publish to GPR (main/feature/tmp) or npm (release) |
| C++ tests | `cpp-tests-<pkg>.yml` or `reusable-cpp-tests-<pkg>.yml` | GoogleTest unit tests |
| C++ coverage | `cpp-test-coverage-<pkg>.yml` | llvm-cov-19 coverage reports |
| Benchmarks | `benchmark-<pkg>.yml` | Performance benchmarks |
| Release notes | `release-notes-check-<pkg>.yml` | Verify CHANGELOG matches version bumps |
| GitHub release | `create-github-release-<pkg>.yml` | Create GitHub release on npm publish |

### SDK Pod (TypeScript packages)

Packages: `qvac-sdk`, `qvac-cli`, `qvac-lib-rag`, `qvac-lib-logging`, `qvac-lib-error-base`, `docs`

| Workflow | File | Purpose |
|----------|------|---------|
| PR validation | `pr-validation-sdk-pod.yml` | Validate PR title/body format |
| PR checks | `pr-checks-sdk-pod.yml` | Lint, typecheck, build, unit tests (dynamic matrix of changed packages) |
| Publish | `publish-qvac-sdk.yml` | Build + publish SDK to GPR/npm |
| Desktop tests | `test-qvac-sdk.yml` | GPU integration tests (currently workflow_dispatch only) |
| Release notes | `release-notes-check-<pkg>.yml` | Verify CHANGELOG matches version bumps |
| GitHub release | `create-github-release-<pkg>.yml` | Create GitHub release on npm publish |

### Simple Libraries with Unit Tests

Packages: `qvac-lib-logging`, `qvac-lib-error-base`

These have unit tests (`npm run test:unit`) but use simple publish workflows for CI.

| Workflow | File pattern | Purpose |
|----------|-------------|---------|
| Publish | `trigger-reusable-lib-<pkg>.yml` | Publish to GPR/npm on merge |

### Simple Libraries (pure JS, no native code)

Packages: `dl-filesystem`, `qvac-lib-dl-hyperdrive`, `dl-base`, `qvac-lib-infer-base`, `qvac-lib-langdetect-text`, `qvac-cli`

| Workflow | File pattern | Purpose |
|----------|-------------|---------|
| Publish | `trigger-reusable-lib-<pkg>.yml` | Publish to GPR/npm on merge (no tests, no builds) |

These delegate to `tetherto/qvac-devops` reusable workflows for publishing.

## Trigger Mechanisms

### Automatic triggers

- **`pull_request_target`** — addon PR workflows (`on-pr-*.yml`) and SDK PR workflows. Fires on: `opened`, `synchronize`, `reopened`, `labeled`. Uses base branch workflow definition (security model for forks).
- **`pull_request`** — release notes checks only. Fires on: `opened`, `synchronize`, `reopened`.
- **`push`** — on-merge and publish workflows. Fires when commits land on `main`, `release-*`, `feature-*`, `tmp-*`.

### Manual triggers

- **`workflow_dispatch`** — all workflows support manual triggering. Common inputs: `ref`, `workdir`, `run_verify`.
- **`workflow_call`** — reusable workflow interface. Prebuilds, integration tests, and mobile tests are called this way from `on-pr-*.yml`.

### CI Package Mapping

These are the native addon packages that have full CI workflows. The **short name** is used as the argument to `/ci-validate` and in the `gh workflow run` trigger command.

| Short name | Package directory | Workflow trigger name |
|---|---|---|
| `LLM` | `packages/qvac-lib-infer-llamacpp-llm` | `On PR Trigger (LLM)` |
| `Embed` | `packages/qvac-lib-infer-llamacpp-embed` | `On PR Trigger (Embed)` |
| `OCR` | `packages/ocr-onnx` | `On PR Trigger (OCR)` |
| `TTS` | `packages/qvac-lib-infer-onnx-tts` | `On PR Trigger (TTS)` |
| `Whispercpp` | `packages/qvac-lib-infer-whispercpp` | `On PR Trigger (Whispercpp)` |
| `Parakeet` | `packages/qvac-lib-infer-parakeet` | `On PR Trigger (Parakeet)` |
| `NMTCPP` | `packages/qvac-lib-infer-nmtcpp` | `On PR Trigger (NMTCPP)` |
| `Decoder-audio` | `packages/qvac-lib-decoder-audio` | `On PR Trigger (Decoder-audio)` |

### How to trigger manually

```bash
# Trigger the PR workflow for a package (use short name from table above)
gh workflow run "On PR Trigger (<Package>)" --repo tetherto/qvac --ref <branch>

# Find the run ID (wait ~5 seconds after trigger)
gh run list --repo tetherto/qvac --workflow "On PR Trigger (<Package>)" --branch <branch> --limit 1 --json databaseId,status

# Watch the run
gh run watch <run-id> --repo tetherto/qvac

# View failed logs
gh run view <run-id> --repo tetherto/qvac --log-failed
```

For SDK packages, PR checks trigger automatically on `pull_request_target` — no manual trigger needed.

## Label Gating

### Addon packages: `verify` label

Without `verify` label, only lightweight checks run:
- `ts-checks` (DTS validation)
- `sanity-checks` (YAML format, disallowed deps, JS lint)
- `release-notes-check`
- `changes` detection

With `verify` label, expensive jobs unlock:
- **Prebuilds** (9 platforms)
- **C++ tests** (GoogleTest)
- **C++ lint** (clang-tidy)
- **Integration tests** (7 platforms)
- **Mobile integration tests** (Android + iOS via AWS Device Farm)

### SDK packages: `safe-to-test` label

For PRs from forks without write access:
- Same-repo PRs and users with write access are always trusted
- External contributors need `safe-to-test` label (auto-stripped on new pushes for re-review)

## Platform Matrix

### Prebuild platforms (9 targets)

| OS | Platform | Arch | Notes |
|----|----------|------|-------|
| ubuntu-22.04 | linux | x64 | |
| ubuntu-22.04-arm | linux | arm64 | Vulkan SDK built from source (S3-cached) |
| ubuntu-24.04 | android | arm64 | `c++_shared` STL |
| macos-14 | ios | arm64 | Native |
| macos-14 | ios-simulator | arm64 | |
| macos-14 | ios-simulator | x64 | |
| macos-14 | darwin | arm64 | |
| macos-15-intel | darwin | x64 | |
| windows-2022 | win32 | x64 | |

### Integration test platforms (7 targets)

| Runner | Platform | Arch | Notes |
|--------|----------|------|-------|
| ubuntu-22.04 | linux | x64 | |
| ai-run-linux-gpu | linux | x64 | Custom GPU runner |
| ubuntu-24.04-arm | linux | arm64 | |
| ubuntu-22.04-arm | linux | arm64 | |
| macos-15-xlarge | darwin | arm64 | |
| macos-15-large | darwin | x64 | |
| ai-run-windows-gpu | win32 | x64 | Custom GPU runner |

Note: integration tests run with `continue-on-error: true` — failures are reported but don't block the pipeline.

### Mobile test platforms (2 targets)

| Platform | Runner | Method |
|----------|--------|--------|
| Android | ai-run-linux | AWS Device Farm |
| iOS | macos-14 | AWS Device Farm |

Both use `continue-on-error: true`.

## Failure Classification Guide

### Infra failures (CI specialist can fix)

These are environment/configuration issues, not code bugs:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| vcpkg cache miss / long vcpkg build | Cache key mismatch after vcpkg.json change | Usually self-resolving on retry; check cache key components |
| `.npmrc` / registry auth failure | Token not set or wrong registry URL | Check workflow `.npmrc` generation step; verify `NPM_TOKEN`/`GH_TOKEN` secrets |
| Runner timeout (>360 min) | Model download too large or test hung | Check if test assets are too large; check timeout setting |
| Vulkan SDK download failure | URL changed or S3 cache expired | Check Vulkan SDK install step URLs |
| `bare-make generate` failure | vcpkg port mismatch or CMake version | Check `vcpkg-configuration.json` and custom ports |
| Disk space error | Runner out of space (common on Ubuntu) | Disk cleanup step may need updating |
| Xcode version not found | iOS runner missing required Xcode | Update Xcode version selection in mobile workflow |
| Android SDK / Gradle failure | Build tools version mismatch | Check `setup-android` and JDK version |
| `merge-guard` failure | External `qvac-devops` workflow issue | Check `tetherto/qvac-devops@monorepo_update` ref |
| Workflow syntax error | YAML issue in workflow file | Validate YAML; check `gh workflow list` for errors |

### Code logic failures (implementer must fix)

These require changes to the project source code:

| Symptom | Likely cause |
|---------|-------------|
| C++ compilation error in `src/` or `binding/` | Code bug — wrong API, missing include, type mismatch |
| GoogleTest assertion failure | C++ unit test found a regression |
| Integration test assertion failure | JS test found a regression in behavior |
| `standard` / `eslint` lint error | Code style violation |
| TypeScript type error | Type mismatch in SDK code |
| `clang-tidy` warning treated as error | C++ code quality issue |
| DTS (`.d.ts`) validation failure | TypeScript declarations don't match exports |
| Release notes check failure | Version bumped but CHANGELOG.md not updated |
| PR validation failure | PR title/body doesn't match format |

### Ambiguous (needs investigation)

| Symptom | Could be |
|---------|----------|
| Flaky test (passes on retry) | Race condition in code OR runner resource contention |
| Model download failure | Network issue OR model repo access revoked |
| Mobile test timeout on Device Farm | Test too slow OR device pool exhausted |
| Intermittent network errors | Runner connectivity OR external dependency down |

**Strategy for ambiguous failures:** retry once. If it fails again with the same error, treat as code logic. If it passes on retry, note the flakiness and move on.

## Troubleshooting — Common Patterns

### "verify" label not triggering workflows

Workflows fire on `labeled` event. If the label was added before the latest push, the workflow may not re-trigger. Fix: remove and re-add the `verify` label, OR use `gh workflow run` to trigger manually.

### Dependency/version check fails on release branch

The `release-merge-guard` job checks that `CHANGELOG.md` has a section matching the `package.json` version. Fix: ensure CHANGELOG has a `## x.y.z` heading matching the version in package.json.

### Prebuild fails on one platform only

Check platform-specific sections of the prebuild workflow:
- **Linux arm64**: Vulkan SDK is built from source and cached on S3 — cache may be stale
- **Windows**: Uses `BitsTransfer` for Vulkan SDK download — URL may have changed
- **iOS simulator**: Needs separate `--simulator` flag in `bare-make generate`
- **Android**: Uses `-D ANDROID_STL=c++_shared` — check NDK compatibility

### Integration test timeouts

Default timeout is 360 minutes. If tests are timing out:
1. Check if model download is included in test time
2. Check if test assets in the package are too large
3. Look at `continue-on-error: true` — the test may have silently hung

### Mobile test failures

Mobile tests use a two-repo checkout (`addon/` + `test-framework/` from `qvac-test-addon-mobile`). Common issues:
- Test framework ref mismatch — check `TEST_FRAMEWORK_REF` env var
- Device Farm pool exhausted — retry later
- App signing failure (iOS) — provisioning profile or certificate expired

## Release & Publish Flow

### Branch -> Publish target

| Branch pattern | Registry | Tag | Package scope |
|---------------|----------|-----|--------------|
| `main` | GitHub Packages (GPR) | `dev` | `@tetherto/<pkg>-mono` |
| `feature-*` | GPR | `feature` | `@tetherto/<pkg>` |
| `tmp-*` | GPR | `temp` | `@tetherto/<pkg>` |
| `release-<pkg>-<x.y.z>` | npm | `latest` | `@qvac/<pkg>` |

### What happens on merge

1. **Push to main/feature/tmp**: `on-merge-*.yml` triggers -> builds prebuilds -> publishes to GPR
2. **Push to release-***: `on-merge-*.yml` triggers -> `release-merge-guard` validates version/changelog -> builds prebuilds -> publishes to npm -> creates GitHub release

### Release PR requirements

- CHANGELOG.md must have a section matching package.json version
- PR title must follow format: `TICKET prefix[tags]: subject`
- All `on-pr-*.yml` checks must pass (including with `verify` label)

## Key Workflow Files — Quick Reference

### Per addon package

Replace `<pkg>` with the package directory name (e.g., `qvac-lib-infer-llamacpp-llm`):

| What | File |
|------|------|
| PR checks (main entry point) | `on-pr-<pkg>.yml` |
| Prebuilds | `prebuilds-<pkg>.yml` |
| Integration tests | `integration-test-<pkg>.yml` |
| Mobile tests | `integration-mobile-test-<pkg>.yml` |
| On merge / publish | `on-merge-<pkg>.yml` |
| C++ tests | `cpp-tests-<short>.yml` or `reusable-cpp-tests-<pkg>.yml` |
| Release notes check | `release-notes-check-<pkg>.yml` |
| GitHub release | `create-github-release-<pkg>.yml` |

### SDK

| What | File |
|------|------|
| PR format validation | `pr-validation-sdk-pod.yml` |
| PR checks (lint, build, test) | `pr-checks-sdk-pod.yml` |
| Publish | `publish-qvac-sdk.yml` |
| Desktop GPU tests | `test-qvac-sdk.yml` |

### Simple libraries

| What | File |
|------|------|
| Publish on merge | `trigger-reusable-lib-<pkg>.yml` |

### External dependencies

- **Reusable workflows/actions**: `tetherto/qvac-devops@monorepo_update`
- **Mobile test framework**: `tetherto/qvac-test-addon-mobile`
- **Merge guard**: `.github/actions/release-merge-guard` (local action)
- **Release notes script**: `.github/scripts/release-notes-check.js`

## Workflow Generations

Addon PR workflows (`on-pr-*.yml`) exist in three evolutionary stages. Newer packages have more features:

1. **Gen 1** (e.g., LLM, Embed): No `changes` job, no `release-notes-check`, no `context` normalization
2. **Gen 2** (e.g., OCR): Adds `changes` job (path filtering via `dorny/paths-filter`), verify gate checks `changes.outputs.pkg`
3. **Gen 3** (e.g., TTS, Parakeet): Adds `context` job for input normalization across trigger types, `release-notes-check`, `cpp-tests-coverage`, `concurrency` groups

When investigating a workflow failure, check which generation the package's `on-pr-*.yml` belongs to — it affects which jobs exist and how they're gated.
