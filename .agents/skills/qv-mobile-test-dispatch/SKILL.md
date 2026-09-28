---
name: qv-mobile-test-dispatch
description: Start an AWS Device Farm mobile integration test for an addon and pick the right prebuild source, so the run tests the binary the developer means rather than the published release. Covers run ids, GPR dev builds, published pins, test filters, device names, and reading the result. Use when someone asks to run mobile tests, test an addon on a device/phone, test a native change on mobile, or invokes /qv-mobile-test-dispatch.
disable-model-invocation: true
---

# mobile-test-dispatch

Mobile integration tests run on **AWS Device Farm**, which is billed per device
minute. They do not run automatically on PRs — someone dispatches them by hand,
choosing one platform, the device(s), and usually a test filter.

The part that goes wrong is **which binary ends up on the phone**. A dispatch
does not compile the addon; it installs a prebuilt one. Get that wrong and the
run is green against code nobody changed.

Canonical reference: [`docs/ci/MOBILE-ON-DEMAND.md`](../../../docs/ci/MOBILE-ON-DEMAND.md).
Read it once per session before answering detailed questions; this skill is the
operating procedure, that doc is the source of truth.

## When to use this skill

- "Run mobile tests for `<addon>`"
- "Test my native change on a device / on a phone"
- "Why did my mobile run test the wrong build?"
- "How do I get a run id?"

## Safety rules

- **Device Farm costs money.** Never dispatch the full suite to explore. Once a
  first run has been done, pass a `tests` filter and the smallest device set that
  answers the question.
- **The exception is a first run on an addon**, which is deliberately the full
  matrix: every supported device, every test. See
  [Step 3b](#step-3b--which-devices-to-run-on). Narrow only after it is green.
- **`llm-llamacpp` is sharded** (7 Android groups, 13 iOS groups) and an empty
  `tests` filter fans each group out as its own Device Farm run — multiplied by
  the device list. A full first run on a sharded addon is legitimate but
  expensive, so say what it will cost before dispatching it; outside a first run,
  always filter for LLM.
- **One platform per dispatch.** Android and iOS are separate runs.
- **A second dispatch of the same workflow on the same branch cancels the
  first.** To cover both platforms, either wait, or use different addons in
  parallel.
- Never dispatch on someone's behalf without telling them it bills Device Farm.

## Step 1 — decide which binary should be tested

| goal | input |
|---|---|
| my own PR's native change | `prebuild_run_id=<run id>` |
| a build from another branch, or a published release | `package=@tetherto/<addon>-mono@<dev>` or `package=@qvac/<addon>@<ver>` |
| just the published release | leave both empty |

`prebuild_run_id` and `package` are **mutually exclusive** — setting both fails
with a message telling you to clear one.

The input is named `package` on most addons but **`package_spec`** on
`asr-ggml`, `audiogen-ggml`, `tts-ggml`. `prebuild_run_id` is the same everywhere.

## Step 2 — get a run id (only for the `prebuild_run_id` route)

**First: the PR must have built prebuilds at all.** The prebuild stage is
label-gated by `ci-router` — it runs only when the PR carries `prebuilds`,
`run-desktop-addon-tests`, or `run-mobile-addon-tests`. With none of those there
is no bundle and no run id. Add the `prebuilds` label and let CI re-run.

**Then:** open the PR's Checks tab, click the run that built the prebuilds, and
take the number at the end of its URL.

Do **not** filter by the addon's own workflow name. Which workflow built the
bundle varies — `on-pr-nx.yml` for most addons, `on-pr-<addon>.yml` for some,
`on-merge-nx.yml` for a branch build. Scope by the PR's head commit:

```bash
PKG=llm-llamacpp   # the package directory name, i.e. packages/<PKG>
PR=1234

SHA=$(gh pr view "$PR" --repo tetherto/qvac --json headRefOid --jq .headRefOid)
for rid in $(gh api "repos/tetherto/qvac/actions/runs?head_sha=$SHA&per_page=100" \
               --jq '.workflow_runs[].id'); do
  gh api "repos/tetherto/qvac/actions/runs/$rid/artifacts?per_page=100" \
    --jq ".artifacts[]|select(.name==\"prebuilds-$PKG\" and .expired==false)|.name" \
    2>/dev/null | grep -q . && { echo "$rid"; break; }
done

# An empty result must not be dispatched: prebuild_run_id="" is the unchanged
# path and quietly resolves @latest, which is the failure this route closes.
```

Nothing printed means either the label is missing, or — on the nx path — that run
only built the addons it considered affected and yours was not one. The dispatch
failure message lists which addons a run did build.

## Step 3 — pick a valid test filter

`tests` is a mocha `--grep` over runner **names**, not file names. A name that
matches nothing is rejected up front by `validate-devices`, for free, with the
list of valid names — so a wrong guess costs nothing but a round trip.

Read the names from the same source `validate-devices` uses:

```bash
# sharded addons (llm-llamacpp, diffusion-cpp, tts-ggml, audiogen-ggml, vla, ...)
jq -r '(.android//{})|[..|strings]|unique|.[]' packages/<PKG>/test/mobile/test-groups.json

# single-spec addons
grep -oE '\brun[A-Z][A-Za-z0-9_]*' packages/<PKG>/test/mobile/integration.auto.cjs | sort -u
```

If a name is rejected on device with
`[prestage] FATAL: tests grep /<name>/ matched no known runner`, it is in neither
the addon's `test-groups.json` nor its `integration.auto.cjs` — i.e. a typo. Take
a name from the commands above. (That FATAL used to fire for *valid* runners too,
because the prestage generator kept its own list; `readKnownRunners()` now reads
`test-groups.json` directly.)

## Step 3b — which devices to run on

**A first run on an addon covers every supported device and every test.** That is
what says whether the change is good. Narrow only afterwards, when re-running a
known failure or iterating on one test.

| Platform | Supported devices |
|----------|-------------------|
| Android  | `Google Pixel 9 Pro`, `Samsung Galaxy S25 Ultra`, `Samsung Galaxy S26 Ultra` |
| iOS      | `Apple iPhone 16 Pro`, `Apple iPhone 17 Pro` |

Not supported — these will schedule and bill, but a failure on one is not acted
on: **Pixel 8 and older** (below the targeted floor) and **Pixel 10** (not
adopted). Any other fleet device can be added deliberately, e.g. to reproduce a
report on specific hardware; say why when you do.

`Google Pixel 9` and `Google Pixel 9 Pro` are different fleet models under the
default `EQUALS` operator. The supported one is the Pro.

## Step 4 — dispatch

First run — full matrix, one dispatch per platform, `tests` left empty. **Run them
in sequence, not back to back:** the concurrency group is keyed on workflow and
ref and does NOT include the platform, so dispatching iOS while Android is still
running cancels Android. Wait for the first to finish, then fire the second.

```bash
gh workflow run integration-mobile-test-<addon>.yml --repo tetherto/qvac --ref <branch> \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro, Samsung Galaxy S25 Ultra, Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id=<run id>

# iOS — only after the Android run finishes, or it cancels it
gh workflow run integration-mobile-test-<addon>.yml --repo tetherto/qvac --ref <branch> \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 16 Pro, Apple iPhone 17 Pro" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id=<run id>
```

Report a first run as complete only when **both** platforms actually completed. A
cancelled Android leg is not a pass, and on `llm-llamacpp` it also discards a
seed-models step budgeted at up to 120 minutes.

Follow-up — one device, one test, after something fails:

```bash
gh workflow run integration-mobile-test-<addon>.yml --repo tetherto/qvac --ref <branch> \
  -f platform=Android \
  -f devices_custom="Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS \
  -f tests=<runnerName> \
  -f prebuild_run_id=<run id>
```

- `devices_custom` takes a comma-separated list and overrides the `device`
  dropdown. Names are full fleet names (`Google Pixel 9 Pro`, `Apple iPhone 16 Pro`).
- `device_model_operator=EQUALS` bills exactly that model; `CONTAINS` may pick a
  different variant.
- `ref` selects the JS harness, tests and app — **not** the native binary. It and
  the prebuild source are deliberately independent.

## Step 5 — read the result

The build job's setup phase prints the provenance:

```
Verified: prebuilds come from run <id> — artifact 'prebuilds-<pkg>',
workflow '<name>', head <sha>, branch <branch> (<repo>), <conclusion>
```

Check the **head SHA** is the commit you meant — a run id resolves whether or not
it built the code under review.

Warnings worth acting on:

- `run <id> concluded 'failure'` — the source run was red. Its prebuild job may
  still be the green part, but confirm.
- `run <id> built code from the FORK '<repo>'` — normal for a fork PR (the repo
  is fork-first), but confirm you meant that contributor's code.

The run-id path **fails closed** — a wrong, private, unfinished or expired run id
fails the run with the reason rather than falling back to `@latest`.

Read the verdict from the run's `test-results.json`, not the workflow conclusion:
a green workflow is not the same as a passed test, and Device Farm's `Totals:`
line counts its own suite rather than your runners.

## Step 6 — attach the run to the PR

A run is only evidence if a reviewer can open it. After a re-run, the link belongs
on the PR as a **comment**. Prefer a comment always: it appends, so nothing can be
lost, and it never has to read what is already there.

**Never post without explicit approval.** This writes to a public repository.
Draft the line, show it, show the exact command, and run it only when the human
says to.

Name the test and the device, so the line reads without opening anything:

```
Re-ran runChatterboxSpeedTest on Samsung Galaxy S26 Ultra after 4e1f2a9:
https://github.com/tetherto/qvac/actions/runs/<id> — total=1 passed=1
```

### Never put a PR body, log line or run output in a shell argument

Write the text to a file and pass the file:

```bash
# compose the note in /tmp/pr-<num>-note.md with the Write tool, then:
gh pr comment <num> --repo tetherto/qvac --body-file /tmp/pr-<num>-note.md
```

Backticks and `$(...)` inside a double-quoted argument run before `gh` does, and
PR bodies and run artifacts on a fork PR are written by third parties. An
approval gate does not help: the human approves the rendered line, not the shell
quoting.

For the description: read it to a file, append there with the Write tool, show
the merged result, then `gh pr edit <num> --body-file <file>`, which replaces the
whole body.

Quote the counts from `test-results.json`. Never report a pass you have not read
out of that file — say what actually ran, including when the answer is that a
failure is still reproducing, and when a leg was cancelled rather than run.

## Per-addon notes

| addon | note |
|---|---|
| `llm-llamacpp` | sharded — always pass `tests` |
| `asr-ggml`, `audiogen-ggml` | `@qvac/*` publishes **no mobile prebuilds**, so an empty input cannot work. Use `prebuild_run_id` or the GPR `-mono` build. |
| `audiogen-ggml` | pins its composite actions to the default branch, so `prebuild_run_id` only works once that support is on `main`; it fails loudly with instructions until then |
| `vla` | package dir is `packages/vla-ggml`, workflow slug is `vla` |
| `decoder-audio` | no native prebuild of its own (rides `bare-ffmpeg` from npm). `package` has no effect; use `ref`. |
| `inference-addon-cpp` | compiles its own prebuilds in-run from the dispatched `ref`, so no prebuild input is needed or offered |

## Reading a failure — where the logs are

The `console-logs-*` artifact on the run is where everything lands. The
`test-results.json` in it only records the harness assertion
(`expect(received).toBe(expected)` at `app.test.js`), which is identical for
every failure and never says why. The real reason is in the app's own output,
and the file differs per platform.

| what | Android | iOS |
|---|---|---|
| JS / bare runtime, TAP lines, the failure | `logcat_full.txt`, `bare` tag | `bare_console.log` |
| **native C++ / engine output** | `logcat_full.txt`, `bare` tag, `[C++ TEST]` prefix | `bare_console.log`, `[C++ TEST]` prefix |
| app shell | `logcat_full.txt`, `ReactNativeJS` tag | `bare_console.log` |
| device/OS noise | `logcat_full.txt` (most of it) | `iOS_appium.log` |

```bash
gh run download <run-id> --repo tetherto/qvac --dir ./logs

# Android — the bare runtime carries BOTH the JS and the C++ output
grep -aE "E bare|I bare" logs/**/*logcat_full.txt | head -40      # test + errors
grep -a "\[C++ TEST\]"    logs/**/*logcat_full.txt | head -40      # native/engine

# iOS — same two, one file
grep -aE "error|not ok"  logs/**/*bare_console.log | head -40
grep -a "\[C++ TEST\]"   logs/**/*bare_console.log | head -40
```

Traps that cost real time:

- **Use `logcat_full.txt`, not `Logcat.logcat`.** They are different files;
  the latter is a smaller capture and does not carry the bare output.
- **Grep the `bare` tag, not TAP markers or the package name.** The runtime
  prints through logcat, so `TAP version`/`ok 1` never appear as raw lines.
- Native C++ lines are prefixed `[C++ TEST] [INFO]: [Llama.cpp] ...` on both
  platforms — the engine logs through the same channel, not a separate tag.
- There is **no `bare_console.log` on Android**, by construction: the app writes
  it into its private data dir, which adb cannot read and `run-as` refuses on a
  release-signed APK. That is expected — logcat is the Android channel.

A real example, the whole reason a run went red, invisible in `test-results.json`:

```
E bare: Test 'runFitStubTest' failed: AddonError: ADDON_NOT_FOUND:
        Cannot find addon '.' from @qvac/model-fit/binding.js
        Candidates: - linked:libqvac__model-fit.0.12.0.so
        [cause]: Error: dlopen fail
```
