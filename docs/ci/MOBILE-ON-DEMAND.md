# Mobile (Device Farm) tests, on demand only

Per-addon mobile integration tests run on **AWS Device Farm**, which is expensive.
They **never run automatically on PRs**. You start them by hand, choosing exactly
one platform, the device(s) to run on, and, where supported, a subset of tests.

All 16 mobile addons are on the CI contract and run through one workflow,
`mobile-tests.yml`: `asr-ggml`, `audiogen-ggml`, `bci-whispercpp`,
`classification-ggml`, `decoder-audio`, `diffusion-cpp`, `embed-llamacpp`,
`ggml-rpc-server`, `inference-addon-cpp`, `llm-llamacpp`, `model-fit`,
`ocr-ggml`, `translation-nmtcpp`, `tts-ggml`, `turbovec-ggml` and `vla-ggml`.
The SDK runs there too, with its own consumer app: `@qvac/sdk` on Android and
iOS, and `sdk-kotlin` (the Kotlin SDK's app) on Android. See
[The SDK's e2e apps](#the-sdks-e2e-apps).

## How to run a mobile test

1. Go to **Actions → `Mobile tests`** (`mobile-tests.yml`).
2. Click **Run workflow**, name the package directory in `packages`, and fill in
   the other inputs (below).
3. Click **Run workflow**.

> Agents (Claude Code, Codex, Cursor) can walk you through this: the
> `qv-mobile-test-dispatch` skill in `.agents/skills/` is the operating procedure
> built on this page.

### Packages on the CI contract

Go to **Actions → `Mobile tests`** (`mobile-tests.yml`) and name the package
directory in `packages`. It takes `platform`, `device` or `devices_custom` (at
least one device), `device_model_operator`, `tests`, `ref`, and one prebuild
source: `prebuild_run_id` (Route A), `package` (Route B), or neither for the
published `@latest`. A package that links a native provider (every fabric
consumer) gets the provider's `prebuilds-<provider>` bundle from the
`prebuild_run_id` run when that run built the provider too;
`dependency_prebuild_run_id` names another run to take it from, and without
either the device uses the published provider. A second dispatch for the same
package on the same branch cancels the first.

**Route A, your PR.** The PR's `PR build and test` run (`pr-build-test.yml`)
builds the prebuilds when the PR carries the `prebuilds` label, and uploads
them as `prebuilds-<dir>`:

```bash
PKG=llm-llamacpp   # package directory, packages/<PKG>
PR=1234
SHA=$(gh pr view "$PR" --repo tetherto/qvac --json headRefOid --jq .headRefOid)
RUN_ID=$(gh run list --repo tetherto/qvac --workflow pr-build-test.yml --commit "$SHA" \
  --limit 1 --json databaseId --jq '.[0].databaseId')

gh workflow run mobile-tests.yml --repo tetherto/qvac --ref main \
  -f packages=$PKG -f ref="refs/pull/$PR/head" \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro" \
  -f device_model_operator=EQUALS \
  -f tests=<runnerName> \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"
```

**Route B, a branch build or a release.** Dispatch `publish-gpr.yml` with
`-f packages=<dir>` on the branch; it publishes
`@tetherto/<name>-mono@<version>-tmp.runid-<run id>`, where `<name>` is the npm
name without `@qvac/`. Pass that spec as `-f package=`, or a published
`@qvac/<name>@<version>`.

Two packages take neither source. `decoder-audio` has no native build of its own
(it rides on `bare-ffmpeg`), and `inference-addon-cpp` has no published package:
its run generates the on-device suite from the desktop suites, builds and tests
its `mobile/` addon on the Linux host (Android only), then compiles the addon for
the platform. For both, the `ref` you name is what gets tested.

A mobile benchmark run goes through `benchmarks.yml` with `run_mobile`; for
`asr-ggml`, `audiogen-ggml` and `tts-ggml` its `args` input picks the one matrix
row the run measures, as `key=value` words, for example `args=engine=parakeet
model_type=ctc use_gpu=true` for asr, `args=dit_variant=sft use_gpu=true` for
audiogen, or `args=engine=supertonic use_gpu=true` for tts. For `diffusion-cpp`
it builds the package and runs the mobile perf suite on that build.

### Quick start: test your own PR on a device

The Route A command above is the common case end to end. A first run should
cover every supported device and every test (see
[Which devices to run on](#which-devices-to-run-on)). The single-device,
single-test form is the follow-up shape: once you are re-running a known failure
or iterating on one test, narrow it, because Device Farm is billed per device
minute.

To find valid runner names for `tests`:

```bash
jq -r '(.android//{})|[..|strings]|unique|.[]' packages/$PKG/test/mobile/test-groups.json 2>/dev/null \
  || grep -oE '\brun[A-Z][A-Za-z0-9_]*' packages/$PKG/test/mobile/integration.auto.cjs | sort -u
```

**Common stops**, all of which fail fast and for free:

| message | meaning |
|---|---|
| `tests filter '<x>' matches none of: …` | wrong runner name; the error lists the valid ones |
| `no EQUALS match on Device Farm for: <model>` | not a fleet model name; the error lists the models there are |
| `Set package or prebuild_run_id, not both` | clear whichever of the two you did not mean |
| the prebuild step cannot find `prebuilds-<dir>` in the run | that run did not build your addon (Nx builds only affected ones), or it has not finished |

### Inputs

| Input | What it does |
|-------|--------------|
| **packages** | The package directories (or npm names) to test, comma-separated. Empty selects every package with a `test:mobile` target. |
| **platform** | The one platform this run targets: `Android` or `iOS`. A manual run is always a single platform. |
| **device** | A dropdown of common pool devices. Pick `(custom)` to type your own in `devices_custom`. The dropdown predates the current supported roster, so for a first run prefer `devices_custom`; see [Which devices to run on](#which-devices-to-run-on). |
| **devices_custom** | A free-text field for one **or more** device models, comma-separated (e.g. `Google Pixel 9 Pro, Samsung Galaxy S25 Ultra`). When set, it **overrides** the dropdown. |
| **device_model_operator** | How the model name is matched: `EQUALS` (**default**: that exact fleet model only) or `CONTAINS` (any model containing the value). |
| **tests** | Optional test filter; see [below](#the-tests-filter). Empty = the full mobile suite. |
| **prebuild_run_id** | The `pr-build-test.yml` run whose `prebuilds-<dir>` bundle to install. **This is the route for testing your own PR on a device.** A run without that bundle fails the run instead of quietly resolving `@latest`. Mutually exclusive with `package`. |
| **package** | Which *published* build to install: `@qvac/<name>@<version>`, or a `@tetherto/<name>-mono@<version>` build from `publish-gpr.yml`. Empty with no `prebuild_run_id` installs the published `@latest`, *not* your branch. |
| **dependency_prebuild_run_id** | A run whose provider bundle (`prebuilds-fabric` for the fabric consumers) replaces the published provider on the device. Empty takes it from the `prebuild_run_id` run when that run built it. |
| **ref** | Git ref to check out for the **test harness / app** (not the native binary). Empty uses the branch you dispatch from. |

### Which devices to run on

**The first run on an addon is the full matrix: every supported device, every
test.** That is what tells you whether the change is good. Narrow only after it
is green, when you are re-running a known failure or iterating on one test.

| Platform | Supported devices |
|----------|-------------------|
| Android  | `Google Pixel 9 Pro`, `Samsung Galaxy S25 Ultra`, `Samsung Galaxy S26 Ultra` |
| iOS      | `Apple iPhone 16 Pro`, `Apple iPhone 17 Pro` |

Leave `tests` empty to run the addon's whole suite. Android and iOS are separate
dispatches, and **the second cancels the first if the Android run is still
going**: the concurrency group is keyed on the ref and `packages`, not platform (see
[One run at a time](#one-run-at-a-time-per-branch)). So a full
first pass is two runs, in sequence:

```bash
BRANCH=$(git branch --show-current)
gh workflow run mobile-tests.yml --repo tetherto/qvac --ref "$BRANCH" -f packages=$PKG \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro, Samsung Galaxy S25 Ultra, Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"

# iOS: only after the Android run finishes, or it cancels it
gh workflow run mobile-tests.yml --repo tetherto/qvac --ref "$BRANCH" -f packages=$PKG \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 16 Pro, Apple iPhone 17 Pro" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"
```

**Not supported.** Adding these to `devices_custom` will schedule and bill a run,
but a failure on one is not a failure the team acts on:

- **Pixel 8 and anything older.** Below the floor the addons target.
- **Pixel 10.** Not adopted; it is deferred in the perf fleet too.

You can still add any other fleet device deliberately, to reproduce a report on
specific hardware, say. Note it in the PR so a reviewer knows why the device list
is not the standard one.

**`Google Pixel 9` is not `Google Pixel 9 Pro`.** Under the default `EQUALS`
operator they are different fleet models, and the supported one is the Pro.

### Device selection: dropdown + free-text

You can pick a device two ways, and they combine:

- **Dropdown (`device`)**: the searchable list of common pool devices. Picks one.
- **Free-text (`devices_custom`)**: a comma-separated list; accepts **multiple**
  devices and any model name (handy for a device that isn't in the dropdown yet).
  If you fill this in, it wins over the dropdown.

Before any build or Device Farm run, a fast **`check`** job checks, up front (so
you never pay for a wasted build or an unschedulable run):

- the requested model(s) **exist** on Device Farm for the chosen platform;
- the `tests` filter (if any) **matches at least one real runner**: a typo that
  would otherwise run zero tests and pass green is rejected here. Sharded addons
  validate against their committed `test-groups.json`, single-spec addons against
  their committed `test/mobile/integration.auto.cjs`. `inference-addon-cpp`
  generates both in the run, so its filter is checked only when Device Farm runs
  the specs;
- the **total run count** (`specs × devices`) is within the cap (see
  [Run-count cap](#run-count-cap-fail-fast)).

A typo, an empty selection, an unknown test filter, or an oversized fan-out fails
immediately and for free.

### Valid device names

A device name is matched as a **`MODEL`** value on Device Farm. **The fleet uses
full manufacturer-prefixed names** (e.g. `Google Pixel 9`, not `Pixel 9`). How the
match works depends on `device_model_operator`:

- **`EQUALS`** (default): your value must be the **exact** fleet model: `Pixel 9`
  is rejected; you must pass `Google Pixel 9`. The dropdown values are already
  exact fleet names, so the default just works and bills exactly the model you
  picked.
- **`CONTAINS`**: your value need only be a substring: `Pixel 9` matches
  `Google Pixel 9` (and `Google Pixel 9 Pro`, `Google Pixel 9a`, …). Use it only
  for a deliberate shorthand match; on a single-device run it can pick a
  different (and slower) variant than you intended.

> **Keep `EQUALS` (the default) for multi-device runs.** Because `CONTAINS` selectors can
> overlap (`Google Pixel 9` and `Google Pixel 9 Pro` both match
> `Google Pixel 9 Pro`), two selectors could land on the **same** physical model
> and bill it twice. the `check` job rejects overlapping selections up
> front, so for any `devices_custom` list with more than one entry pass exact,
> distinct fleet names with `-f device_model_operator=EQUALS`.

The dropdown uses **exact** names so they work with either operator:

| Platform | Supported `MODEL` values | Manufacturer |
|----------|--------------------------|--------------|
| Android  | `Google Pixel 9 Pro`, `Samsung Galaxy S25 Ultra`, `Samsung Galaxy S26 Ultra` | `Google` / `Samsung` |
| iOS      | `Apple iPhone 16 Pro`, `Apple iPhone 17 Pro` | `Apple` |

These are the models the team supports; see
[Which devices to run on](#which-devices-to-run-on). The fleet carries others,
and `devices_custom` will happily run them; they are simply not what a result is
judged against.

`devices_custom` accepts any of the above, a bare substring (with `CONTAINS`), or
any other model on the fleet. **This table can drift** as the fleet changes, so the
authoritative list is Device Farm itself. Two ways to see it:

1. **Let the workflow tell you (easiest).** Dispatch the run with a made-up device
   (e.g. `devices_custom: nope`). The `check` job fails fast and its error lists the
   models Device Farm has for that platform. No build or Device Farm run is charged.
2. **Query AWS directly** (needs Device Farm read access; region is `us-west-2`):

```bash
aws devicefarm list-devices \
  --filters '[{"attribute":"PLATFORM","operator":"EQUALS","values":["ANDROID"]}]' \
  --query 'devices[].model' --output json | jq -r '.[]' | sort -u
```

Swap `ANDROID` for `IOS` for the iOS list.

### The `tests` filter

The `tests` input runs **only the tests you name**, so you don't pay to run the
whole suite. It is **by test name, not by file name.**

- It is a **[mocha](https://mochajs.org/) `--grep` regex**, matched against the
  mobile **test-runner names** in the addon's `test/mobile` tests (for sharded
  addons these are the names listed in `test/mobile/test-groups.json`). Most
  addons name these `run*` (e.g. `runChatterboxSpeedTest`, `runLlmSpeedTest`),
  but the exact names are addon-specific: audiogen, for instance, uses
  `testLoadModels`, `testGenerateMusicOnGpu`. Always check the addon's runner
  source (or its `test-groups.json`) for the exact names to pass.
- Combine several with `|`, e.g. `runLlmSpeedTest|runLlmMemoryTest`. A partial
  pattern works too: `runChatterbox` runs (and pre-stages models for) every
  runner whose name matches.
- Leave it **empty** to run the full mobile suite.

For sharded addons (e.g. `llm-llamacpp`, `ocr-ggml`), a `tests` filter collapses
the many shards into a single filtered run, a big cost saving. Leaving it empty
on a sharded addon runs the **full** shard set pinned to your chosen device(s),
which is many runs.

**A typo can't waste money or pass green.** The `check` job matches your filter
against the committed runner names *before* any build, and fails fast (printing
the known runners) if it matches none, so a mistyped filter can't reach the
device, select zero tests, and report a false pass. Model pre-staging follows the same regex: only the models the matched
runners need are staged; anything unmatched is simply fetched on-device (a
partial pattern like `runBenchmarkPerf` stages every shard it selects, not
nothing). On a `benchmarks.yml` run, which passes no `tests` filter,
pre-staging **fails closed** if the shard grep matches no known runner, so a
`test-groups` ↔ model-map drift surfaces instead of silently shipping an
under-staged run. (`vla-ggml` is the one
exception: its manifest is built from presigned URLs that may legitimately be
absent, so it fails closed only when the grep matches no known runner *name*,
and still falls back to on-device download when a known runner's URL isn't baked
yet.)

#### Where to find the test names (per addon)

The valid names live in the addon repo, under its mobile test folder:

- **Sharded addons** (they ship `test/mobile/test-groups.json`): the exact grep
  strings are the values inside that file, e.g.
  `packages/llm-llamacpp/test/mobile/test-groups.json`,
  `packages/ocr-ggml/test/mobile/test-groups.json`. Every listed test is a valid
  `tests` value; a group's whole set is those names joined with `|`.
- **All addons**: the runnable names are the `run*` functions declared in the
  generated `packages/<addon>/test/mobile/integration.auto.cjs` (grep for
  `async function run`). These are exactly what the mobile run greps against.

If in doubt, run once **without** a filter and open the Device Farm run's
`bare_console.log` / the "Run → tests" legend on the job summary; it enumerates
the `run*` names that executed, which you can then narrow with `tests`.

### Where the logs are when a run fails

`test-results.json` only records the harness assertion, which is the same for
every failure. The reason is in the app's own output:

| what | Android | iOS |
|---|---|---|
| JS / bare runtime, TAP, the failure | `logcat_full.txt`, `bare` tag | `bare_console.log` |
| **native C++ / engine** | `logcat_full.txt`, `bare` tag, `[C++ TEST]` prefix | `bare_console.log`, `[C++ TEST]` prefix |

```bash
gh run download <run-id> --repo tetherto/qvac --dir ./logs
grep -aE "E bare|I bare" logs/**/*logcat_full.txt   # Android: test + native
grep -a "\[C++ TEST\]"    logs/**/*bare_console.log  # iOS: native
```

Use `logcat_full.txt`, **not** the smaller `Logcat.logcat`, and grep the `bare`
tag rather than TAP markers: the runtime prints through logcat, so `ok 1` never
appears as a raw line. There is no `bare_console.log` on Android by construction
(private app data, unreadable by adb on a release-signed APK).

### Which build gets tested

A manual run does **not** compile the package's native addon (except
`inference-addon-cpp`'s test addon); it installs a **prebuilt** one:

- **`prebuild_run_id=<run id>`** → install the `prebuilds-<dir>` bundle **that
  run built**, after checking it carries this platform. A run id that is wrong,
  builds no bundle for the package, or whose artifact has expired fails the run.
- **`package=<spec>`** → install that published build: `@qvac/<addon>@1.2.3` from
  npm, or `@tetherto/<addon>-mono@<dev-version>` from GitHub Packages. The
  `-mono` suffix is the name `publish-gpr.yml` publishes; the un-suffixed
  `@tetherto/<addon>` packages are dead leftovers or do not exist.
- **Neither** → the published **`@qvac/<addon>@latest`**: the release, *not*
  your branch's native code.

The run checks the installed prebuilds are the package's own before it builds the
app. Split addons (`@qvac/fabric`, `diffusion-cpp` and the speech addons) publish
their `@qvac` release as a JS-only meta package plus per-platform packages; the
install takes the platform package the meta's `#host-addon` map names, at the
same version. Nothing changes about what you pass.

For a package that links a native provider, the provider comes from the
published runtime unless the run, or `dependency_prebuild_run_id`, supplies its
bundle.

### Testing unmerged / unpublished native code

`--ref <branch>` (or `-f ref=`) gives you the branch's JS harness, tests and app
but **never** its compiled `.bare`. If your change touches `addon/src/**`, a
run without a prebuild source exercises your new tests against the **published**
engine and passes for the wrong reason. Use Route A for your own PR: its
`PR build and test` run built the prebuilds, and `prebuild_run_id` installs
exactly those. The prebuild stage is **label-gated**: the PR needs the
`prebuilds`, `run-cpp-addon-tests` or `run-desktop-addon-tests` label, or there
is no bundle and no run id to point at.

Use Route B for a build from another branch or a release: dispatch
`publish-gpr.yml` on that branch with `-f packages=<dir>`, then pass the
`@tetherto/<name>-mono@<version>` it printed as `package`.

> The **`ref`** input defaults to **blank**, so the run checks out the branch you
> dispatch from (`gh workflow run … --ref <branch>`, no `-f ref=` needed). Pass
> `-f ref=<tag/sha>` only to override it. `ref` drives the JS test harness and
> the app; it does **not** drive the native prebuild. The `check` job reads the
> runner list from the same `ref`, so a branch that renames or adds runners is
> checked against its own list.

### One run at a time (per branch)

`mobile-tests.yml` has a concurrency guard keyed on the branch and `packages`: a
new dispatch **cancels the in-flight one for the same branch and packages**, so you
can never stack two Device Farm runs (and two bills). Dispatches on **different
branches, or for different packages, are independent**.

## Typical flow (worked example)

A manual run targets **one platform at a time** (the `platform` input is `Android`
*or* `iOS`), because each platform has its own device fleet. Covering both is just
two dispatches. The usual pattern is two steps:

### 1. Broad coverage: run the pool, per platform

Run the full suite across the phones you care about (one dispatch per platform):

```bash
# Android: across the pool phones (one run per exact model)
gh workflow run mobile-tests.yml --ref <branch> -f packages=tts-ggml \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro, Samsung Galaxy S25 Ultra, Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS

# iOS: the iPhones
gh workflow run mobile-tests.yml --ref <branch> -f packages=tts-ggml \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 16 Pro, Apple iPhone 17 Pro" \
  -f device_model_operator=EQUALS
```

Run the iOS dispatch only after the Android one finishes: same workflow, same
package and branch, so a second dispatch cancels the first. The same dispatch is
available from **Actions → Mobile tests → Run workflow** in the UI.

### 2. Narrow after a failure: one device, one test

When a device fails, don't re-run everything. Re-dispatch **just that device** with
**just the failing test** (`tests` is a mocha `--grep` on the runner name; see
[the tests filter](#the-tests-filter)):

```bash
# e.g. runChatterboxSpeedTest failed on the S26 Ultra; re-run only that
gh workflow run mobile-tests.yml --ref <branch> -f packages=tts-ggml \
  -f platform=Android \
  -f devices_custom="Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS \
  -f tests="runChatterboxSpeedTest"
```

This is the cheap, fast loop for reproducing/fixing a single failure without paying
for the whole pool again.

**Attach the run to the PR.** A re-run is only evidence if a reviewer can open it,
so put its link in the PR. Prefer a **comment**: it appends, so nothing can be
lost and nothing has to be read back first. Use the description only when the
link belongs in the write-up itself.

```
Re-ran runChatterboxSpeedTest on Samsung Galaxy S26 Ultra after 4e1f2a9:
https://github.com/tetherto/qvac/actions/runs/<id>: total=1 passed=1
```

Say which **test** and which **device**, so the link is readable without opening
it.

Pass the text as a **file**, never as a shell argument:

```bash
# compose the note in /tmp/pr-<num>-note.md first
gh pr comment <num> --repo tetherto/qvac --body-file /tmp/pr-<num>-note.md
```

Backticks and `$(...)` inside a double-quoted argument run before `gh` does, and
on a fork PR the body and the run artifacts are written by someone else. Same for
`gh pr edit`: read the body to a file, append there, write it back with
`--body-file`. An agent doing this must show the text and the command and get
your approval first. Read the verdict from the run's `test-results.json` rather than the workflow
conclusion: a green workflow is not the same as a passed test, and Device Farm's
own `Totals:` line counts its own suite, not your runners. When a run is red, see
[Where the logs are when a run fails](#where-the-logs-are-when-a-run-fails).

### Run-count cap (fail-fast)

To stop a single dispatch from spraying the whole fleet, two safety rails are
enforced by the `check` job **before any build**:

- **≤ 10 unique devices** per dispatch.
- **≤ 40 total Device Farm runs**, where `runs = specs × devices`. `specs` is the
  number of shards for the platform when `tests` is empty, or **1** when you pass a
  `tests` filter (a filter collapses the run to a single grepped spec).
  Single-spec addons are always `specs = 1`.

The full supported matrix fits on every addon today: 3 Android devices and 2 iOS
devices, so the worst cases are `tts-ggml` Android at `9 × 3 = 27` runs and
`llm-llamacpp` iOS at `13 × 2 = 26`. Adding devices beyond the supported set is
what pushes a shard-heavy addon over: `llm-llamacpp` iOS with 3 devices is
`13 × 3 = 39`, and a fourth breaks the cap. If you exceed it, either **add a
`tests` filter** (drops `specs` to 1) or **reduce devices**. Both caps fail fast
and free.

## The SDK's e2e apps

`@qvac/sdk` and `sdk-kotlin` are producer packages: their `test:mobile` builds the
SDK e2e consumer app from `packages/sdk-e2e`, and the run drives it over MQTT
from the runner instead of a test package on the device. For them:

- `devices` names one Device Farm pool from the `SDK_ANDROID_DEVICE_FARM_POOLS` or
  `SDK_IOS_DEVICE_FARM_POOLS` repository variable, not a device model. Leave it
  empty to take an available private pool first, else a random public one.
  Dispatch the SDK on its own: a device model in `devices` names no pool and
  fails its run.
- `tests` takes comma-separated catalog categories or testId prefixes, not a
  mocha `--grep`; empty runs the full catalog.
- `package`, `prebuild_run_id` and `dependency_prebuild_run_id` do not apply:
  the app always builds this commit's `packages/sdk`, `packages/inference` and
  `packages/test-suite`.
- The job summary compares the results with the newest dispatch run's on the
  base branch, and `<package>-results-<configuration>` holds the reports.

```bash
gh workflow run mobile-tests.yml --ref <branch> -f platform=Android -f packages=@qvac/sdk
gh workflow run mobile-tests.yml --ref <branch> -f platform=Android -f packages=sdk-kotlin
```

## PRs and Merge Guard

- No pull request workflow starts Device Farm. Mobile runs only by dispatch, from
  `mobile-tests.yml` or `benchmarks.yml`.
- Mobile status is not part of the Merge Guard: it is not a required (or
  optional-but-reported) check, so a mobile run can never block a merge.
- The **`run-mobile-addon-tests` label** starts no mobile suite. See
  [LABELS.md](./LABELS.md).

## Publishing

Packages publish from `publish-npm.yml` and `publish-gpr.yml`, which run no
mobile E2E or desktop integration tests. Generated-wrapper verification
(`verify:generated`) remains a pre-publish integrity gate, including on release
pushes and manual dispatches without a PR.
