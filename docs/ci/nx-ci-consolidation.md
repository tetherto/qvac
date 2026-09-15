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

`config-ref` defaults to the affected base; callers on `pull_request_target` pass `github.event.repository.default_branch` so config is always read from the trusted default branch. See "Fork safety".

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
  ├─ coload-smoke-mobile→ coload-smoke-mobile.yml        (asr/tts on-device co-load)
  ├─ perf-report(-rtf)                                   (informational)
  ├─ publish-prebuild-status  (scripts/prebuild-status/publish.mjs → qvac/prebuild-<pkg>)
  └─ merge-guard        → public-pr.yml                  (produces qvac-merge-guard / validate-pr)

on-merge-nx.yml         (push to main/release/feature/tmp)  ── publish orchestrator
  ├─ detect             (per-package prebuild/publish matrices)
  ├─ prebuild           → prebuilds-nx.yml     (packages: ["<pkg>"] override)
  ├─ integration        → integration-test-nx.yml (packages override, desktop gate)
  └─ publish            (GPR/npm + tag, per package)

benchmark-performance-nx.yml  (workflow_dispatch)  ── matrix → prebuilds-nx → integration-test-nx (RTF)
```

The three leaves `prebuilds-nx.yml`, `cpp-tests-nx.yml`, `integration-test-nx.yml` are `workflow_call` reusables. Each starts with a `matrix` job that runs `nx-project-matrix` for its target, then fans out over the resulting rows. They are callable standalone via `workflow_dispatch` (base-ref/head-ref inputs) for testing.

## `options.ci` cheat-sheet

Per target, common fields (see any `packages/*/project.json`):

- **build** — `artifactNamePrefix`, `includeVulkanSdk`, `includeRocm`, `linuxExtraPackages`, `macBrewPackages`, `extraCmakeDefines`, `platformCmakeDefines`. Presence of `build.options.ci` is what makes a package "have prebuilds" (`hasPrebuilds` is derived, not declared).
- **on-pr** — `hasCppLint`, `hasTsChecks` (`tsChecksMode`), `hasFabricLockstep`, `hasCoload`/`coloadActive`, `hasPerfReport` (`perfReportVariant`, `perfReportPattern`, `perfReportTitle`, `perfReportExtraArgs`).
- **test:cpp** — `platforms[]` (os/platform/arch/runner), `vcpkgMode`, `coverageOn`, `mode`, plus per-package flags; `carveOut: true` routes to a bespoke reusable.
- **test:integration** — usually just `carveOut: true` for packages with bespoke integration flows (asr, llm).
- **benchmark** — `aggregateScript`, `manualDir`.
- **on-merge** — `buildStep`, `nameTransform`, `repoName`, `testGateMode`.

Per-run overrides are possible via the action's `overrides` input, but only for fields a package already declares (validated, so a PR can't inject new CI behaviour).

## Fork safety

`on-pr-nx.yml` runs on `pull_request_target` — the base-repo workflow with secrets, against fork code. The rule: **base = control surface, head = code-under-test.**

- The `matrix`, `ci-router`, `authorize` jobs check out their action + config from `default_branch` (never head), and `nx-project-matrix` reads `options.ci` via `git show default_branch:...`. A fork editing its own `project.json` cannot change what CI runs.
- Every privileged job (`prebuild`, `cpp-tests`, `run-integration-tests`, `coload-smoke*`, `merge-guard`, ...) has `fork-approval` first in `needs:` and gates on `authorize.outputs.allowed`. Fork head never runs until a maintainer approves.
- The leaves build/test the **head** SHA (`github.event.pull_request.head.sha`) — that's the point — but only after the gates pass.

Enforced by `.github/scripts/test/ci-trust-policy.test.mjs`.

## Carve-outs

Packages with bespoke flows set `carveOut: true` on the relevant target. `nx-project-matrix` surfaces them in the `carveouts` output; the orchestrator routes them to their own reusable (`integration-test-asr-ggml.yml`, `integration-test-llm-llamacpp.yml`, `cpp-tests-llm.yml`, translation cpp) instead of the generic matrix. They still self-affect from their own `project.json`.

## Merge guard

`pr-gate-merge.yml` → `public-pr.yml` produces the single required check `qvac-merge-guard / validate-pr`. Its `verify-prebuilds` step reads the `qvac/prebuild-<pkg>` commit statuses posted by `on-pr-nx`'s `publish-prebuild-status` job, trusting **only** the `on-pr-nx.yml` producer and the newest fresh status (`scripts/prebuild-status/lib.mjs`, unit-tested in `prebuild-status.test.mjs`). Wiring a new gated job in: see `docs/ci/MERGE-GUARD.md` / the `qv-merge-guard-wire` skill.

## Mobile

Mobile is intentionally **not** consolidated. The per-package `integration-mobile-test-<pkg>.yml` and `on-merge` mobile gates stay byte-identical to `main`. The only mobile touchpoints in the nx line are the asr/tts on-device `coload-smoke-mobile` job (main-parity) on PRs and the dispatch-only mobile benchmark jobs.

## Adding / changing a package's CI

1. Edit that package's `packages/<pkg>/project.json` — add/adjust the `options.ci` block for the relevant target. No workflow edits needed for shape changes.
2. New package: give it the targets it needs (`build`, `on-pr`, `test:cpp`, ...) with `options.ci`; the leaves pick it up once it's nx-affected. Config must land on the default branch first (that's the trusted ref the matrix reads).
3. Validate: `node .github/scripts/test/ci-trust-policy.test.mjs`, `actionlint`, and a standalone `workflow_dispatch` of the affected leaf with `base-ref`/`head-ref`.
