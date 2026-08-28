# Mobile (Device Farm) tests — on-demand only

Per-addon mobile integration tests run on **AWS Device Farm**, which is expensive.
To cut that cost, they **no longer run automatically on PRs**. Instead you start
them by hand, choosing exactly one platform, the device(s) to run on, and
(optionally) a subset of tests.

This applies to all 14 mobile addons: `asr-ggml`, `audiogen-ggml`,
`bci-whispercpp`, `classification-ggml`, `decoder-audio`, `diffusion-cpp`,
`embed-llamacpp`, `inference-addon-cpp`, `llm-llamacpp`, `model-fit`, `ocr-ggml`,
`translation-nmtcpp`, `tts-ggml`, `vla`.

## How to run a mobile test

1. Go to **Actions → `Mobile Integration Tests (<addon>)`**.
2. Click **Run workflow** and fill in the inputs (below).
3. Click **Run workflow**.

### Inputs

| Input | What it does |
|-------|--------------|
| **platform** | The one platform this run targets — `Android` or `iOS`. A manual run is always a single platform. |
| **device** | A searchable dropdown of common pool devices (e.g. `Pixel 9`, `iPhone 17`). Pick `(custom)` if you want to type your own in `devices_custom`. |
| **devices_custom** | A free-text field for one **or more** device models, comma-separated (e.g. `Pixel 9, Pixel 8`). When set, it **overrides** the dropdown. Use it for new/uncommon devices or to run several at once. |
| **device_model_operator** | How the model name is matched: `EQUALS` (**default** — that exact fleet model only; dropdown values are exact fleet names) or `CONTAINS` (any model containing the value — Device Farm picks by availability, so `Pixel 9` can also match `Pixel 9 Pro`). Default is `EQUALS` so a single-device run bills exactly the model you picked. |
| **tests** | Optional test filter — see [below](#the-tests-filter). Empty = the full mobile suite. |
| **package** (or **package_spec**) | Which build to actually put on the phone — see [below](#which-build-gets-tested). Default **empty** = this branch's native prebuild artifact. |
| **ref** | Git ref to check out for the **test harness / app** (not the native binary — see below). |

### Device selection: dropdown + free-text

You can pick a device two ways, and they combine:

- **Dropdown (`device`)** — the searchable list of common pool devices. Picks one.
- **Free-text (`devices_custom`)** — a comma-separated list; accepts **multiple**
  devices and any model name (handy for a device that isn't in the dropdown yet).
  If you fill this in, it wins over the dropdown.

Before any build or Device Farm run, a fast **`validate-devices`** job checks, up
front (so you never pay for a wasted build or an unschedulable run):

- the requested model(s) **exist** on Device Farm for the chosen platform;
- the `tests` filter (if any) **matches at least one real runner** — a typo that
  would otherwise run zero tests and pass green is rejected here. This now covers
  **every addon**: sharded addons validate against their `test-groups.json`,
  single-spec addons against their committed `test/mobile/integration.auto.cjs`,
  and `inference-addon-cpp` regenerates its runner map (one shard per desktop
  suite) at validation time;
- the **total run count** (`specs × devices`) is within the cap (see
  [Run-count cap](#run-count-cap-fail-fast)).

A typo, an empty selection, an unknown test filter, or an oversized fan-out fails
immediately and for free.

### Valid device names

A device name is matched as a **`MODEL`** value on Device Farm. **The fleet uses
full manufacturer-prefixed names** (e.g. `Google Pixel 9`, not `Pixel 9`). How the
match works depends on `device_model_operator`:

- **`EQUALS`** (default): your value must be the **exact** fleet model — `Pixel 9`
  is rejected; you must pass `Google Pixel 9`. The dropdown values are already
  exact fleet names, so the default just works and bills exactly the model you
  picked.
- **`CONTAINS`**: your value need only be a substring — `Pixel 9` matches
  `Google Pixel 9` (and `Google Pixel 9 Pro`, `Google Pixel 9a`, …). Use it only
  for a deliberate shorthand match; on a single-device run it can pick a
  different (and slower) variant than you intended.

> **Keep `EQUALS` (the default) for multi-device runs.** Because `CONTAINS` selectors can
> overlap (`Google Pixel 9` and `Google Pixel 9 Pro` both match
> `Google Pixel 9 Pro`), two selectors could land on the **same** physical model
> and bill it twice. `validate-devices` now rejects overlapping selections up
> front, so for any `devices_custom` list with more than one entry pass exact,
> distinct fleet names with `-f device_model_operator=EQUALS`.

The dropdown uses **exact** names so they work with either operator:

| Platform | Exact `MODEL` values (dropdown) | Manufacturer |
|----------|---------------------------------|--------------|
| Android  | `Google Pixel 9`, `Google Pixel 8`, `Samsung Galaxy S25 Ultra` | `Google` / `Samsung` |
| iOS      | `Apple iPhone 17`, `Apple iPhone 16 Pro`, `Apple iPhone 15` | `Apple` |

`devices_custom` accepts any of the above, a bare substring (with `CONTAINS`), or
any other model on the fleet. **This table can drift** as the fleet changes, so the
authoritative list is Device Farm itself. Two ways to see it:

1. **Let the workflow tell you (easiest).** Dispatch the run with a made-up device
   (e.g. `devices_custom: nope`). The `validate-devices` job fails fast and prints
   **`Available <PLATFORM> device models:`** — the full, current model list for that
   platform. No build or Device Farm run is charged.
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
  but the exact names are addon-specific — audiogen, for instance, uses
  `testLoadModels`, `testGenerateMusicOnGpu`. Always check the addon's runner
  source (or its `test-groups.json`) for the exact names to pass.
- Combine several with `|`, e.g. `runLlmSpeedTest|runLlmMemoryTest`. A partial
  pattern works too: `runChatterbox` runs (and pre-stages models for) every
  runner whose name matches.
- Leave it **empty** to run the full mobile suite.

For sharded addons (e.g. `llm-llamacpp`, `ocr-ggml`), a `tests` filter collapses
the many shards into a single filtered run — a big cost saving. Leaving it empty
on a sharded addon runs the **full** shard set pinned to your chosen device(s),
which is many runs.

**A typo can't waste money or pass green.** For **every** addon the
`validate-devices` job matches your filter against the real runner names *before*
any build, and fails fast (printing the known runners) if it matches none — so a
mistyped filter can't reach the device, select zero tests, and report a false
pass. Model pre-staging follows the same regex: only the models the matched
runners need are staged; anything unmatched is simply fetched on-device (a
partial pattern like `runBenchmarkPerf` stages every shard it selects, not
nothing). On the automated `workflow_call` lanes (weekend / on-merge /
benchmarks) — which never run `validate-devices` — pre-staging **fails closed**
if the shard grep matches no known runner, so a `test-groups` ↔ model-map drift
surfaces instead of silently shipping an under-staged run. (`vla-ggml` is the one
exception: its manifest is built from presigned URLs that may legitimately be
absent, so it fails closed only when the grep matches no known runner *name*,
and still falls back to on-device download when a known runner's URL isn't baked
yet.)

#### Where to find the test names (per addon)

The valid names live in the addon repo, under its mobile test folder:

- **Sharded addons** (they ship `test/mobile/test-groups.json`): the exact grep
  strings are the values inside that file — e.g.
  `packages/llm-llamacpp/test/mobile/test-groups.json`,
  `packages/ocr-ggml/test/mobile/test-groups.json`. Every listed test is a valid
  `tests` value; a group's whole set is those names joined with `|`.
- **All addons**: the runnable names are the `run*` functions declared in the
  generated `packages/<addon>/test/mobile/integration.auto.cjs` (grep for
  `async function run`). These are exactly what the mobile run greps against.

If in doubt, run once **without** a filter and open the Device Farm run's
`bare_console.log` / the "Run → tests" legend on the job summary — it enumerates
the `run*` names that executed, which you can then narrow with `tests`.

### Which build gets tested

A manual run does **not** compile the native addon — it installs a **prebuilt**
one. Which prebuild depends on the `package` / `package_spec` input:

- **Empty (default)** → artifact-first resolution: prebuild artifacts **from the
  same run**, then the published **`@qvac/<addon>@latest`** if there are none.
  A standalone dispatch builds no prebuilds of its own, so in practice **empty
  means `@latest`** — the published release, *not* your branch's native code.
  (Artifacts only exist when the mobile workflow is invoked via `workflow_call`
  from a run that built them, i.e. the on-merge / benchmark / weekend paths.)
- **`@qvac/<addon>@1.2.3`** → force-install that exact **published npm** version.
- **`@tetherto/<addon>-mono@<dev-version>`** → force-install a specific **branch
  build** from GitHub Packages (GPR). Note the **`-mono`** suffix: that is the
  name `publish-library-to-gpr` actually publishes (`name-suffix: "-mono"` in
  every `on-merge-*.yml`). The un-suffixed `@tetherto/<addon>` packages are dead
  leftovers or do not exist. Setting any non-empty spec flips
  `force-npm-prebuild` on.

> **Testing an unmerged native change.** `--ref <branch>` gives you the branch's
> JS harness, tests and app — but **never** its compiled `.bare`. If your change
> touches `addon/src/**`, you must point `package` / `package_spec` at a GPR dev
> build, or the run will exercise your new tests against the **published**
> engine and pass for the wrong reason.
>
> To get one: push your branch as `tmp-<TICKET>` (or otherwise trigger the
> addon's **On Merge Trigger** workflow). It publishes
> `@tetherto/<addon>-mono@<pkg-version>-tmp.runid-<run id>`. Take the version
> from that run and pass it:
>
> ```bash
> gh workflow run integration-mobile-test-<addon>.yml --ref <branch> \
>   -f platform=Android \
>   -f devices_custom="Google Pixel 9" \
>   -f device_model_operator=EQUALS \
>   -f tests="runSomethingTest" \
>   -f package="@tetherto/<addon>-mono@<version>-tmp.runid-<run id>"
> ```
>
> Confirm it took effect in the job log — the download step prints
> `Verified: prebuilds come from <name>@<version> (pinned, GitHub Packages …)`.

> The **`ref`** input defaults to **blank**, so the run checks out the branch you
> dispatch from (`gh workflow run … --ref <branch>` — no `-f ref=` needed). Pass
> `-f ref=<tag/sha>` only to override it. `ref` drives the JS test harness and
> the app; it does **not** drive the native prebuild, which always comes from an
> artifact or a package (see above).
>
> The `tests`-filter / shard-count validation reads the runner list from the
> **same commit** the build executes, so if your branch renames or adds runners
> (or shards), `validate-devices` checks against your branch's list — a stale
> default-branch copy can't wave a mistyped filter through. A blank `ref` pins to
> the **exact commit** that triggered the run (`github.sha`), shared by every job,
> so a push mid-run can't make validation and build inspect different code. The
> composite actions themselves always run from the trusted workflow ref, never
> from `ref`.

**Exceptions:**

- **`inference-addon-cpp`** has no published package — it **compiles its `.bare`
  natively in the same run from `ref`**, so a branch dispatch already tests that
  branch's native code directly (no `package` input, none needed).
- **`decoder-audio`** has no native prebuild of its own (it rides on
  `bare-ffmpeg`'s), so its `package` input does not change what is tested.

### One run at a time (per branch)

Each mobile workflow has a concurrency guard: a new manual dispatch **cancels the
previous in-flight dispatch of the same workflow on the same branch**, so you can
never accidentally stack two Device Farm runs (and two bills). Dispatches on
**different branches are independent** — that is what lets a few test branches run
in parallel. The `workflow_call` paths (benchmarks / weekend / on-merge) are never
cancelled by this.

## Typical flow (worked example)

A manual run targets **one platform at a time** (the `platform` input is `Android`
*or* `iOS`), because each platform has its own device fleet. Covering both is just
two dispatches. The usual pattern is two steps:

### 1. Broad coverage — run the pool, per platform

Run the full suite across the phones you care about (one dispatch per platform):

```bash
# Android — across the pool phones (one run per exact model)
gh workflow run integration-mobile-test-tts-ggml.yml --ref <branch> \
  -f platform=Android \
  -f devices_custom="Google Pixel 9, Google Pixel 8, Samsung Galaxy S25 Ultra" \
  -f device_model_operator=EQUALS

# iOS — the iPhones
gh workflow run integration-mobile-test-tts-ggml.yml --ref <branch> \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 16 Pro, Apple iPhone 17 Pro" \
  -f device_model_operator=EQUALS
```

These run in parallel and each reports its own verdict. (Once the workflow is on
the default branch you can do the same from **Actions → Run workflow** in the UI.)

### 2. Narrow after a failure — one device, one test

When a device fails, don't re-run everything. Re-dispatch **just that device** with
**just the failing test** (`tests` is a mocha `--grep` on the runner name — see
[the tests filter](#the-tests-filter)):

```bash
# e.g. runChatterboxSpeedTest failed on the Pixel 8 — re-run only that
gh workflow run integration-mobile-test-tts-ggml.yml --ref <branch> \
  -f platform=Android \
  -f devices_custom="Google Pixel 8" \
  -f device_model_operator=EQUALS \
  -f tests="runChatterboxSpeedTest"
```

This is the cheap, fast loop for reproducing/fixing a single failure without paying
for the whole pool again.

### Run-count cap (fail-fast)

To stop a single dispatch from spraying the whole fleet, two safety rails are
enforced by `validate-devices` **before any build** (and re-checked by the
scheduler as a backstop):

- **≤ 10 unique devices** per dispatch.
- **≤ 40 total Device Farm runs**, where `runs = specs × devices`. `specs` is the
  number of shards for the platform when `tests` is empty, or **1** when you pass a
  `tests` filter (a filter collapses the run to a single grepped spec). Single-spec
  addons are always `specs = 1`; `inference-addon-cpp` counts one shard per desktop
  suite (regenerated at validation time), so its fan-out is bounded correctly too.

So the broad example above (3 devices, no filter) is fine on every addon — e.g.
`tts-ggml` has 9 Android shards → `9 × 3 = 27` runs. Broad coverage on a
shard-heavy addon may hit the cap (e.g. `llm-llamacpp` iOS has 13 shards →
`13 × 3 = 39`); if you exceed it, either **add a `tests` filter** (drops `specs`
to 1) or **reduce devices**. Both caps fail fast and free.

## What changed on PRs

- The `run-mobile-integration-tests` lane was removed from the `on-pr-*`
  workflows so opening/updating a PR no longer launches Device Farm. The
  mobile-only wrapper `on-pr-inference-addon-cpp.yml` had its automatic
  `pull_request_target` trigger disabled instead (it has no other lane); its
  gating machinery is preserved.
- Mobile status was **dropped from the Merge Guard**: it is no longer a required
  (or optional-but-reported) check, so a mobile run can never block a merge.
- The **`run-mobile-addon-tests` label is kept** but no longer starts a standalone
  mobile suite. It still gates the on-device (Device Farm) co-load smoke where
  that exists. See [LABELS.md](./LABELS.md).

## What did **not** change

The reusable (`workflow_call`) paths are untouched — benchmarks, the weekend run,
and on-merge triggers still call the same `integration-mobile-test-<addon>.yml`
workflows with their existing inputs and scheduling (sharded / dual-flagship /
single-pool). The on-demand behaviour is additive and only kicks in for a direct
`workflow_dispatch` run.

## Re-enabling automatic PR runs (later)

Everything needed to bring back the PR lane is intentionally preserved: the
`run-mobile-addon-tests` label, the `ci-router` `run_mobile` output, and the
gating jobs. Re-add the `run-mobile-integration-tests` job to the relevant
`on-pr-*` workflow to turn it back on. For `inference-addon-cpp`, also restore the
`pull_request_target` trigger in `on-pr-inference-addon-cpp.yml`.
