# SDK Tests

SDK dogfooding tests built on [`@tetherto/qvac-test-suite`](https://github.com/tetherto/qvac-test-suite).
A producer orchestrates a shared queue of tests over MQTT; a consumer runs them on desktop (Node) or mobile
(Bare + React Native).

## Running locally

```bash
cd packages/sdk/tests-qvac
npm run install:build                # installs deps + builds tests
cp .env.example .env                 # only needed if you want to point at a remote broker

npx qvac-test run:local:desktop
npx qvac-test run:local:android
npx qvac-test run:local:ios
```

**MQTT broker.** `run:local:*` requires a broker serving WebSockets on port 8080 and MQTT/TCP on 1883.
If nothing is detected on localhost, the command prompts to install `aedes` + `websocket-stream` globally and
runs an embedded broker for the duration of the test run. Bring your own broker if you prefer — just expose
`ws://...:8080` and `mqtt://...:1883`.

**Common flags.** All `run:local:*` commands accept `--filter`, `--suite`, `--exclude-suite`, `--runId`.
Mobile adds `--skip-build` (see below). Run `npx qvac-test run:local:<platform> --help` for the full list.

**Platform prerequisites.**

- iOS: Xcode + connected device trusted in Xcode. Team ID auto-detected; override with `QVAC_IOS_TEAM_ID`.
- Android: `adb` + USB-debuggable device.
- Desktop: Node 22+.

### Rebuilding after changes

Which rebuild command you run depends on what changed.

| You changed                              | Command                         | Rebuild mobile app?                       |
| ---------------------------------------- | ------------------------------- | ----------------------------------------- |
| SDK source (`packages/sdk/` outside tests-qvac) | `npm run install:build:full`    | Yes — `--skip-build` will miss the change |
| Test code or assets in `tests-qvac/`     | `npm run install:build`         | Yes when running on mobile                |
| Only the producer side (filter, suite)   | none                            | No — use `--skip-build`                   |

- `install:build` = `npm install --install-links && npm run build`. Picks up changes in this package.
- `install:build:full` = `prepare:sdk` (bun install + bun run build in `packages/sdk/`) + `install:build`.
  Use after any SDK change. If you've already rebuilt the SDK yourself (`cd .. && bun run build`), plain
  `install:build` is enough.
- **Mobile requires a fresh APK/IPA** to pick up either SDK or test-code changes — the baked app bundle
  contains the compiled test executors and the SDK. Omit `--skip-build` to rebuild.
- **`--skip-build` is for fast iteration that doesn't touch compiled code**: re-running the same build with
  a different `--filter` or `--suite`, or just re-running to debug flakiness. The producer reads
  definitions fresh each run, so filter / suite changes are picked up without rebuilding.

## Running in CI

### Label-triggered on PRs

See [`.github/workflows/on-pr-test-sdk.yml`](../../../.github/workflows/on-pr-test-sdk.yml).

- `test-e2e-smoke` — runs the `smoke` suite on all platforms.
- `test-e2e-full` — runs the full catalog on all platforms.
- Release-branch PRs with SDK changes auto-run the full suite.
- Success applies the `e2e-tested` label.

### Manual runs

Open [Actions → QVAC Tests (sdk) → Run workflow](https://github.com/tetherto/qvac/actions/workflows/test-sdk.yml)
and submit the form.

Non-obvious inputs:

- **"Use workflow from" (GitHub's own selector) vs `test-version`** — these are independent. The selector
  picks the branch that supplies the *workflow YAML*; `test-version` is the git ref that gets checked out for
  the *code under test* (and the tests-qvac package). Leave `test-version` blank to test the same branch the
  workflow was loaded from. Set it to test workflow edits from one branch against SDK code on another.
- `suite` + `suite-custom` — pick `custom` to pass arbitrary comma-separated suite tags via `suite-custom`.
- `desktop-platforms` — JSON array of runner labels; defaults to all three GPU runners. Narrow to one during
  debugging.

The remaining inputs (`targets`, `filter`, `exclude-suite`, timeouts, `cache-models`) are self-explanatory in
the form.

## Developing new tests

- **Definitions** live in [`tests/<feature>-tests.ts`](./tests), aggregated in
  [`tests/test-definitions.ts`](./tests/test-definitions.ts). Each entry is a `TestDefinition` with `testId`,
  `params`, `expectation`, optional `suites`, and `metadata`.
- **Executors — pick one of three locations based on runtime requirements:**
  - [`tests/shared/executors/`](./tests/shared/executors) — **default**. Pure SDK API calls, no Node stdlib,
    no RN APIs. Runs on both desktop and mobile. Example:
    [`completion-executor.ts`](./tests/shared/executors/completion-executor.ts).
  - [`tests/desktop/executors/`](./tests/desktop/executors) — needs `node:fs`, `node:path`, `process.cwd()`,
    or other Node-only APIs. Example: [`rag-executor.ts`](./tests/desktop/executors/rag-executor.ts) reads
    documents from disk.
  - [`tests/mobile/executors/`](./tests/mobile/executors) — needs React Native-specific asset loading
    (`Platform`, bundled assets). Example:
    [`mobile/executors/ocr-executor.ts`](./tests/mobile/executors/ocr-executor.ts).
- Register new executors in [`tests/desktop/consumer.ts`](./tests/desktop/consumer.ts) and
  [`tests/mobile/consumer.ts`](./tests/mobile/consumer.ts) as applicable. Mobile platform skips go through
  `SkipExecutor` at the top of the mobile consumer (first match wins).
- **Smoke suite policy.** If a new feature introduces core functionality that has no existing smoke coverage,
  tag **1-2** tests with `suites: ["smoke"]` — preferring the most representative, fastest, least-flaky test.
  Verify it passes predictably on both desktop and mobile before tagging. Smoke must stay focused and fast; do
  not tag additional tests for a feature that is already covered.
- Assets go under [`assets/`](./assets). Update [`qvac-test.config.js`](./qvac-test.config.js)
  `consumers.mobile.assets.patterns` if the new files aren't covered by existing globs.
- One-time setup (model pre-download, warmup) goes in the exported `bootstrap()` function of each consumer
  entry.

## Troubleshooting

- **No device detected** — `adb devices` (Android) or `xcrun devicectl list devices` (iOS). USB
  trust/debugging must be enabled.
- **iOS signing errors** — open [`build/consumers/ios/ios/QVACTestConsumer.xcworkspace`](./) in Xcode once and
  set the Team under Signing & Capabilities, or export `QVAC_IOS_TEAM_ID`. If Xcode keeps failing, change
  `QVAC_IOS_BUNDLE_ID` to a suffix unique to your Apple account.
- **MQTT broker unreachable** — the embedded broker needs `aedes` + `websocket-stream`. `run:local:*` offers
  to install them globally; accept, or run `npm install -g aedes websocket-stream` yourself.
- **Manual iOS build fallback** — when the automated flow fails, build from the generated Xcode workspace
  manually:

    ```bash
    npx qvac-test build:consumer:ios --runId <run-id> --config .
    cd build/consumers/ios/ios
    xcodebuild \
      -workspace QVACTestConsumer.xcworkspace \
      -scheme QVACTestConsumer \
      -configuration Release \
      -destination 'id=<device-udid>'
    ios-deploy --bundle ~/Library/Developer/Xcode/DerivedData/<derived-data-dir>/Build/Products/Release-iphoneos/QVACTestConsumer.app
    npx qvac-test run:producer --runId <run-id> --config .
    ```
