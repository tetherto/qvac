# Package CI contract

Packages tagged `ci:contract` in their `project.json` share one set of workflows, the groups. A group never knows a package by name: it asks Nx which packages changed, reads their targets and configurations, and runs `nx run-many` on each configuration's runner. How a package builds, tests and publishes lives in that package's `project.json`, its `ci/` directory and its model manifest.

List the packages on the contract:

```bash
pnpm exec nx show projects --projects tag:ci:contract
```

A package without the tag runs the workflows it names itself, such as the SDK's `pr-checks-sdk-pod.yml`. Change CI on the side the package is on.

## Groups

| Group | Runs on | Targets it runs |
|---|---|---|
| `pr-checks.yml` | every pull request; no secrets | `lint`, `typecheck`, `test:unit`, `verify:generated`, and the workspace range check |
| `pr-build-test.yml` | every pull request, after fork approval and trust | `build`, `cpp:lint`, `cpp:build`, `cpp:tests`, `test:integration`, `test:backend` |
| `mobile-tests.yml` | dispatch | `test:mobile` |
| `benchmarks.yml` | dispatch | `build`, `benchmark`, `test:mobile` |
| `cache-warm.yml` | push to `main` on cache inputs, schedule, dispatch | `cache:models`, `build`, `cpp:tests` |
| `publish-npm.yml` | push to `release-<dir>-<x.y.z>`, dispatch (`dry_run`) | `build`, `verify:generated`, `publish` |
| `publish-gpr.yml` | dispatch | `build`, `verify:generated`, `publish` |

Each group calls `_select-projects.yml` for its rows, then the templates `_build.yml`, `_cpp-lint.yml`, `_cpp-tests.yml`, `_desktop.yml` and `_mobile.yml` run them. `.github/scripts/select-projects.mjs` is the only code that reads a package's CI settings. A group that builds calls `_build.yml` twice: first for its providers' rows (see [Native dependencies](#native-dependencies)), then for the packages' own.

In `pr-build-test.yml`, stages beyond `cpp:lint` run on labels: `prebuilds` builds, `run-cpp-addon-tests` adds C++ tests, and `run-desktop-addon-tests` adds desktop tests. Both test labels build too. Mobile runs only by dispatch (`docs/ci/MOBILE-ON-DEMAND.md`).

## project.json

### Targets

A package on the contract declares only these targets:

| Target | What it does | Configurations |
|---|---|---|
| `lint`, `typecheck`, `test:unit`, `verify:generated` | JavaScript checks, one job per package | no |
| `ci:setup` | Prepares the checkout, for example registry configuration | no |
| `ci:system` | Installs the system packages a configuration needs; idempotent | named like the build's, `commands` only |
| `build` | Builds the native prebuilds | yes |
| `link:platform` | Links a native dependency's prebuilds into `node_modules` | no |
| `cpp:lint` | Lints the C++ the change touched; with `--generate "<command>"`, `cpp-lint-changed.mjs` generates and lints only when the change touched a C/C++ file in the package | yes |
| `cpp:build`, `cpp:tests` | Builds and runs the C++ test binary | yes |
| `test:integration`, `test:backend` | Desktop tests | yes |
| `test:mobile` | Prepares the Device Farm test package | yes |
| `cache:models` | Marks the package for model cache warming; `nx:noop` | no |
| `benchmark` | Runs the package's benchmarks; its `report` configuration then reads every configuration's results | yes, plus `report` |
| `publish` | Marks the package as publishable; `nx:noop` | no |

Every package command is a target command. A group's step runs `nx run-many`, never `bare-make`, a `ci/` script or a package script directly. Tooling stays in the groups' steps: checkout, toolchain setup, artifacts, Device Farm, and packing and publishing to a registry. `ci:setup` and `ci:system` set `options.forwardAllArgs: false`, so an argument meant for a later target never reaches their commands.

### Configurations

Each platform a target runs on is an Nx configuration of that target, named `<platform>-<arch>[-<variant>]`: `linux-x64`, `linux-x64-gpu`, `ios-arm64-simulator`. A configuration holds only:

- `args`: appended to the target's commands that set `forwardAllArgs: true`. Put the platform flags here, so the commands stay written once.
- `commands`: replaces the target's commands on this platform, when the step itself differs.
- `ci.runner`: the runner key from `reusable-runner-names.yml`.
- `ci.setup`: extra host toolkits: `cuda` or `rocm`; `cuda-jetson`, the CUDA 12 toolkit for Jetson beside the host's CUDA 13, exported only as `QVAC_CUDA_JETSON_PATH` for the commands that read it; or `python` for Python 3.10 on a desktop leg.

`benchmark` may also define `report`, the one configuration not named for a platform. `benchmarks.yml` runs it once on Linux after every other configuration and the mobile runs finish, with their results downloaded under `<dir>/benchmarks/results/`. A benchmark command writes its own results there, and reads `BENCHMARK_ARGS`, `QVAC_PERF_RUNS` and `QVAC_PERF_WARMUP_RUNS` when the dispatch sets them.

`nx run-many -c <configuration>` passes the configuration to the target's dependencies that define it, so `ci:system` and the build of a native dependency run with the same configuration.

### Metadata

| Key | Target | Meaning |
|---|---|---|
| `timeoutMinutes` | any | the job's timeout |
| `toolchain` | `build` | toolchain pins; set once in `nx.json`'s build `targetDefaults` |
| `mobile` | `test:mobile` | `devicefarmProject`, `enablesPerf`, `mochaTimeoutMs`, `waitforTimeoutMs`, `perTestTimeoutMinutes`, `jobTimeoutMinutes` (the Device Farm job timeout, 120 by default), `perfReport` |
| `publish` | `publish` | `tagPrefix` for the release tag; `platformPackages: true` publishes one npm package per platform before the meta; `nameTransform: rename-prefix` renames the `qvac_` prebuild files and `binding.js` references to `tetherto_` in the GitHub Packages build |
| `prebuildExtraDirs` | `publish` | prebuild directories besides the platform ones that the meta package ships, such as fabric's `include` and `share` |
| `secrets` | `test:integration`, `test:backend`, `benchmark`, `test:mobile` | secrets the command reads from its environment, from `SECRETS` in `select-projects.mjs` (`QASE_API_TOKEN`, `HF_TOKEN`, `MODEL_S3_BUCKET`, and `GITHUB_TOKEN`, the job's token) |

`test:mobile` may set step outputs for its run: `test-groups`, `device-env`, `mocha-timeout-ms`, `per-test-timeout-minutes`, `enables-perf` (`true` turns on the perf report for a run whose metadata leaves `enablesPerf` off), `after-hook-pulls` (a JSON list of `{device_path, artifact_name}` copied off the device into the run's logs), and `workdir` (the directory of the addon the test app bundles, when it is not the package's own).

### Models

The jobs that run a target fetch its models first, from the package's one manifest, `test/integration/models.manifest.json`; a package without it has no models. Package tools that read the same file skip the entries that are not theirs. Each entry names one source:

- `s3Path`: one object, into `dest`.
- `s3Prefix`: a directory, synced into `dest`, skipping the `exclude` globs.
- `urls`: pinned mirrors, into `dest`, by default `test/model/<name>`; `sha256` and `bytes` are checked when set.

`targets` lists the targets that need the entry, by default `test:integration` only; `skip` lists `<platform>-<arch>` hosts that never need it; `warm: false` leaves it to the tests.

`nx.json`'s build `toolchain` pins the toolkit versions (`cuda` 13.0.3 and `cudaJetson` 12.6.3 among them; `setup-cuda`'s default is the same CUDA 13 pin), and its `hostSetup` names the toolkits each host installs for build and C++ lint jobs, whose native dependencies' exported CMake configs may look for them.

### Native dependencies

A package that links another package's native build depends on that package's `link:platform` by name, not on `^build`:

```json
"dependsOn": [{ "projects": ["@qvac/fabric"], "target": "link:platform" }]
```

`link:platform` depends on the dependency's `build`; `^build` would also build every workspace package below it.

A dependency on the contract is a **provider**. Selection finds providers from these `dependsOn` entries, never by name, and returns them as their own build rows (`build:providers`), one per configuration that the selected `build` and `cpp:lint` rows use. A configuration the provider does not define fails selection, naming the provider, the package and the configuration. A selected provider's own build rows join its provider rows, so each configuration builds once per run.

The provider rows build first. A package's build and C++ lint jobs then restore `prebuild-<provider>-<configuration>`, run the provider's `link:platform`, and run their target with `--exclude-task-dependencies`, so they never compile the provider. When a provider leg fails, no package build leg runs in that run, and every selected package's `qvac/prebuild-<key>` status reports failure. A provider posts its own status and `prebuilds-<slug>` bundle only from a run that selected it.

A dependency off the contract is built inside each job that needs it, through the target's own dependencies.

`pr-checks.yml` fails a pull request when a workspace package's range on a provider, or on one of the provider's `#host-addon` platform packages, excludes the provider's workspace version (`scripts/ci/check-workspace-ranges.mjs`): pnpm would install the old release from npm instead of linking the workspace provider. Bump a provider's dependents' ranges with it.

## Prebuilds

- Each build job uploads `prebuild-<slug>-<configuration>`, holding `packages/<dir>/prebuilds` for every package it built or restored, providers included.
- A build leg is reused from an earlier same-repository run on the branch, or on the default branch (where `cache-warm.yml` builds them), when the package's and its providers' native files, its row and the build inputs are unchanged. `.github/scripts/prebuild-reuse.mjs` keys the legs.
- `pr-build-test.yml`'s merge job folds each package's own folder into `prebuilds-<slug>`, the bundle mobile tests install. The publish groups place only the package's own folder, so a dependency never ships inside it.
- C++ and desktop test jobs restore `prebuild-<slug>-<platform>-<arch>`, run `link:platform` on what they restored, and run their target with `--exclude-task-dependencies`. Every platform and architecture a test configuration uses needs a build configuration.
- A package without a `build` target restores no prebuilds: its C++, desktop and mobile rows run against the installed workspace and the package itself.
- A mobile run given a `prebuild_run_id` installs the provider's `prebuilds-<provider>` bundle from that run when the run has one; `dependency_prebuild_run_id` names another run to take it from. Otherwise the device uses the published provider runtime.

## Trust

Every job in `pr-build-test.yml` that holds secrets, OIDC or runs pull-request code needs `trust` and runs only when `needs.trust.outputs.allowed == 'true'`; `trust` needs `fork-approval`. `pr-checks.yml` holds no secrets.

## Shared CI changes

A pull request that changes only the groups, `select-projects.mjs` or an action they call selects no package. See `docs/ci/MERGE-GUARD.md` for what Merge Guard requires then, and how to run `pr-build-test.yml` for one package.

## Checks

- `.github/scripts/test/ci-contract-standard.test.mjs` checks every tagged package against this standard: target names, configurations, metadata, runner keys, `forwardAllArgs` on the host targets, and a build configuration for every configuration that restores one. It also checks that the groups request only standard targets.
- `select-projects.mjs` applies the same rules when it builds rows, and rejects a request for a target outside the standard.
- `ci-trust-policy.test.mjs` checks the trust gate in `pr-build-test.yml` and the Merge Guard filter entries.
- `scripts/ci/check-workspace-ranges.mjs` runs in `pr-checks.yml` on every pull request.
