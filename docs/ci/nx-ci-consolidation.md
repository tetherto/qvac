# Nx CI consolidation

How the per-package CI workflows are consolidated into generic `-nx.yml` leaves driven by pnpm + Nx.

## Why

Every native-addon package used to carry its own near-identical `on-pr-<pkg>.yml`, `prebuilds-<pkg>.yml`, `cpp-tests-<pkg>.yml`, `integration-test-<pkg>.yml`, `benchmark-performance-<pkg>.yml`, and `on-merge-<pkg>.yml`. 80+ files that drifted independently and had to be changed in lockstep. The consolidation replaces them with a handful of generic leaves that run **only** the packages a PR actually touches, with each package's CI shape declared as data in its `project.json`.

## Prerequisite: the workspace

This builds on the pnpm + Nx workspace. Read `docs/pnpm-nx-workspace.md` first for the tooling (workspace config, Nx affected graph, `project.json` as config source, local commands). The one thing CI relies on:

- **Nx affected graph** — `nx show projects --affected -t <target>` scopes a run to only the packages a diff touches (transitively).
- **`project.json` `options.ci`** — each package declares its CI shape as data; there are no Nx executors doing real work, targets just wrap `pnpm run <script>`.

## The matrix action

`.github/actions/nx-project-matrix/action.yml` is the single bridge from Nx config to a GitHub Actions matrix. Given a `target`, it:

1. Computes affected packages (or takes an explicit `packages: ["<pkg>"]` override that bypasses nx-affected — used by on-merge for per-package publish).
2. Reads each affected package's `options.ci` for that target from a **trusted ref** via `git show <config-ref>:packages/<pkg>/project.json` — never the checked-out (PR-head) tree.
3. Emits a flattened `{package, platform, ...ci-fields}` JSON matrix, an `any` boolean, and a `carveouts` list (packages flagged `carveOut: true`, routed to bespoke reusables instead of the generic matrix).

`config-ref` defaults to the affected base; callers on `pull_request_target` pass `github.event.repository.default_branch` so config is always read from the trusted default branch. A manual `on-pr-nx.yml` dispatch can set `config_ref_override` to test package selection and desktop integration configuration from an explicit trusted branch. The integration caller forwards that manual override as its `base-ref`; PR events continue to use the default branch. See "Fork safety".

## Workflow wiring

```
on-pr-nx.yml            (pull_request_target)  ── PR orchestrator
  ├─ fork-approval      (reusable-fork-approval.yml)   gate: fork must be approved
  ├─ ci-router          (actions/ci-router)            label -> which stages run
  ├─ authorize          (actions/authorize-pr)         gate: PR authorized
  ├─ matrix             (actions/nx-project-matrix, target: on-pr, config-ref: default_branch)
  ├─ prebuild           → prebuilds-nx.yml              (target: build)
  ├─ cpp-tests          → cpp-tests-nx.yml              (target: test:cpp)
  ├─ run-integration    → integration-test-nx.yml       (target: test:integration)
  ├─ sanity-checks / cpp-lint / ts-checks / fabric-lockstep   (matrix-filtered from on-pr ci)
  ├─ coload-smoke       → coload-smoke.yml               (desktop co-load)
  ├─ coload-smoke-mobile→ coload-smoke-mobile.yml        (on-device co-load)
  ├─ perf-report(-rtf)                                   (informational)
  ├─ publish-prebuild-status  (scripts/prebuild-status/publish.mjs → qvac/prebuild-<pkg>)
  ├─ publish-cpp-test-status  (scripts/prebuild-status/publish.mjs KIND=cpp-tests → qvac/cpp-tests-<pkg>)
  └─ merge-guard        → public-pr.yml                  (package-level merge-guard / validate-pr; not the required check)

on-merge-nx.yml         (release-* push / workflow_dispatch)  ── publish orchestrator
  ├─ detect             (per-package prebuild/publish matrices)
  ├─ prebuild           → prebuilds-nx.yml     (packages: ["<pkg>"] override)
  ├─ verify-generated   → verify-generated-wrappers.yml (publish integrity gate)
  ├─ integration        → integration-test-nx.yml (opt-in; no current packages)
  └─ publish            (GPR/npm + tag, per package)

benchmark-performance-nx.yml  (workflow_dispatch)  ── matrix → prebuilds-nx → integration-test-nx (RTF)
```

The three leaves `prebuilds-nx.yml`, `cpp-tests-nx.yml`, `integration-test-nx.yml` are `workflow_call` reusables. Each starts with a `matrix` job that runs `nx-project-matrix` for its target, then fans out over the resulting rows. They are callable standalone via `workflow_dispatch` (base-ref/head-ref inputs) for testing.

## `options.ci` cheat-sheet

Per target, common fields (see any `packages/*/project.json`):

- **build** — `artifactNamePrefix`, `includeVulkanSdk`, `includeRocm`, `includeCuda`, `linuxExtraPackages`, `macBrewPackages`, `extraCmakeDefines`, `platformCmakeDefines`. Presence of `build.options.ci` is what makes a package "have prebuilds" (`hasPrebuilds` is derived, not declared).
- **on-pr** — `hasCppLint`, `hasTsChecks` (`tsChecksMode`), `hasFabricLockstep`, `cppTestsBaseline` (run the package's `test:cpp` lane on every PR, without the `run-cpp-addon-tests` label), `hasCoload`/`coloadActive`, `hasPerfReport` (`perfReportVariant`, `perfReportPattern`, `perfReportTitle`, `perfReportExtraArgs`).
- **test:cpp** — `platforms[]` (os/platform/arch/runner), `vcpkgMode`, `coverageOn`, `mode`, plus per-package flags; `carveOut: true` routes to a bespoke reusable.
- **test:integration** — `platforms[]` rows, each able to override any shared field (e.g. `timeoutMinutes`, `modelDownloadScript`); `testScript`, the npm script a leg runs instead of `test:integration` (darwin-x64 legs point it at a single-suite smoke script); `carveOut: true` for packages with bespoke integration flows. After the leaf stages `prebuilds/<host>/`, a package whose `package.json` defines `link:platform` gets that script run, so `#host-addon` loads the staged build rather than the optionalDependency pin in git.
- **benchmark** — `aggregateScript`, `manualDir`.
- **on-merge** — `buildStep`, `nameTransform`, `repoName`, `testGateMode`.

Per-run overrides are possible via the action's `overrides` input, but only for fields a package already declares (validated, so a PR can't inject new CI behaviour).

The speech packages (`asr-ggml`, `audiogen-ggml`, `bci-whispercpp`, `decoder-audio`, `tts-ggml`) are on the CI contract (`docs/ci/workflow-standard.md`). Their `cpp:lint` runs only when the change touched a C/C++ source or header in the package, through `scripts/ci/cpp-lint-changed.mjs --generate`, and their C++ tests run in `_cpp-tests.yml` on the Ubuntu 22.04 x64 CPU runner. `cpp-lint-selection.mjs` keeps the same rule for them on `on-pr-nx.yml`, where none runs today.

The consolidated coverage lane restores vcpkg binaries from the host cache and
the package's keyed cache, including its build mode, triplets, and toolchain
fingerprint. Only trusted default-branch builds write shared caches.

`cpp-tests-nx.yml` warms its own vcpkg and compiler caches, in both build modes.
Its warm roster is every package whose PR legs build in its `test-cpp` matrix:
one whose `on-pr` and `test:cpp` targets both declare `options.ci` without
`carveOut`. `.github/scripts/cpp-tests-warm-roster.mjs` reads the roster from
`project.json`, so a package joins or leaves it with those targets. Packages that
already have their own `on-merge-vcpkg-cache-*.yml` dispatcher (`WARMED_ELSEWHERE`
in the script) are left to it.

- A push to `main` warms the roster packages it touched, or the whole roster when
  it changes a shared cache input: the workflow, the `vcpkg-*` actions,
  `configure-cpp-build.mjs`, or `vcpkg-overlays/`.
- A schedule every 2 days warms the whole roster. The cache server prunes an entry
  after 5 days without an upload or download, so the longest gap stays at 4 days
  even after one failed run.

Carve-outs keep their own vcpkg caches and warm them separately.
`translation-nmtcpp` warms its own on pushes and on its own 2-day schedule;
`llm-llamacpp` and `model-fit` are warmed by their `on-merge-vcpkg-cache-*.yml`
dispatchers. `cpp-tests-warm-roster.test.mjs` fails for a carve-out with neither.

The warm run after a cache key change builds cold and saves the new entry. A
manual `CPP Tests (nx)` dispatch on `main` with explicit packages also warms the
caches:

```bash
gh workflow run cpp-tests-nx.yml --ref main -f packages='["diffusion-cpp"]'
```

A coverage target can enable ccache (`hasCcache`). Each job then uses its own
package cache directory under `RUNNER_TEMP`, restores entries for the same
toolchain and dependencies, and trusted builds save a fresh run-specific key.
`cppBuildJobs` defaults to two and caps both CMake and vcpkg parallelism.
Coverage generation and artifact collection still run after a failed test if
the build succeeded.

To try a different setting, dispatch the same `main` commit with explicit
packages and an `overrides` JSON object. It accepts only fields already declared
in the trusted package configuration, and applies them to each of the package's
platform rows. For example, diffusion's C++ tests in standard mode:

```bash
gh workflow run cpp-tests-nx.yml --ref main -f packages='["diffusion-cpp"]' \
  -f overrides='{"diffusion-cpp":{"mode":"standard"}}'
```

Package config is read from the trusted base ref. After merging a runner change into `main`, start a new run for an existing PR to resolve the updated matrix; already queued jobs retain the labels selected by their original run.

## Fork safety

`on-pr-nx.yml` runs on `pull_request_target` — the base-repo workflow with secrets, against fork code. The rule: **base = control surface, head = code-under-test.**

- The `matrix`, `ci-router`, `authorize` jobs check out their action + config from `default_branch` (never head), and `nx-project-matrix` reads `options.ci` via `git show default_branch:...`. A fork editing its own `project.json` cannot change what CI runs.
- Every privileged job (`prebuild`, `cpp-tests`, `run-integration-tests`, `coload-smoke*`, `merge-guard`, ...) has `fork-approval` first in `needs:` and gates on `authorize.outputs.allowed`. Fork head never runs until a maintainer approves.
- The leaves build/test the **head** SHA (`github.event.pull_request.head.sha`) — that's the point — but only after the gates pass.

Enforced by `.github/scripts/test/ci-trust-policy.test.mjs`.

## Carve-outs

Packages with bespoke flows set `carveOut: true` on the relevant target. `nx-project-matrix` surfaces them in the `carveouts` output; the orchestrator routes them to their own reusable instead of the generic matrix. They still self-affect from their own `project.json`.

## Merge guard

`pr-gate-merge.yml` → `public-pr.yml` produces the single required check `qvac-merge-guard / validate-pr`. `verify-prebuilds` reads `qvac/prebuild-<pkg>` statuses from `publish-prebuild-status`; `verify-cpp-tests` reads `qvac/cpp-tests-<pkg>` statuses from `publish-cpp-test-status`. Both trust only the package's own producer (`on-pr-nx.yml`, or the carved-out package's `on-pr-<pkg>.yml`) and the newest fresh status from it (`scripts/prebuild-status/lib.mjs`, unit-tested in `prebuild-status.test.mjs`). Wiring a new gated job in: see `docs/ci/MERGE-GUARD.md` / the `qv-merge-guard-wire` skill.

## Mobile

Mobile tests for the packages left on this path use the per-package
`integration-mobile-test-<pkg>.yml` workflows; the packages on the CI contract,
the speech packages among them, run theirs through `mobile-tests.yml` and publish
through `publish-npm.yml` and `publish-gpr.yml`. Publishing in `on-merge-nx.yml`
reads each package's `on-merge.options.ci.testGateMode` from the trusted default
branch. Prebuilds, generated-wrapper verification and publishing remain enabled.
Wrapper verification is a publish-integrity gate for release pushes and manual
dispatches, including those that never open a PR.

The pre-publish integration job, post-build gate, post-publish integration job
and publish-step test gates remain supported opt-in paths controlled by
`testGateMode` (and `postIntegrationOnGpr` for GPR post-publish tests). No current
package opts in; their integration matrices are empty. Synthetic policy tests
exercise both selectors and the pre/post-publish gates so these paths remain
covered without enabling them for a real package.
Desktop test targets, on-demand mobile tests, and benchmark workflows remain
available independently of publishing.

Desktop integration on PRs requires the `run-desktop-addon-tests` label; mobile
E2E tests require an explicit dispatch. Publishing does not require either run,
so a release can reach npm without integration coverage. Removing the
post-publish runs also removes their automatic signal of a broken published
build. No replacement schedule or mandatory release-PR integration gate is
introduced by this policy.

## Adding / changing a package's CI

1. Edit that package's `packages/<pkg>/project.json` — add/adjust the `options.ci` block for the relevant target. No workflow edits needed for shape changes.
2. New package: give it the targets it needs (`build`, `on-pr`, `test:cpp`, ...) with `options.ci`; the leaves pick it up once it's nx-affected. Config must land on the default branch first (that's the trusted ref the matrix reads).
3. Validate: `node .github/scripts/test/ci-trust-policy.test.mjs`, `actionlint`, and a standalone `workflow_dispatch` of the affected leaf with `base-ref`/`head-ref`.
