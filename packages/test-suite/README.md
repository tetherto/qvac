# @qvac/test-suite

Distributed MQTT-based test orchestration for desktop, Electron, Snap, and mobile consumers.

## Features

- Desktop consumers for `macos`, `windows`, and `linux`
- Electron packaged app consumers for `macos`, `windows`, and `linux`
- Strict-confined Snap consumers for Linux
- Mobile consumers for `ios` and `android`
- Typed config and message contracts with Zod
- Producer/consumer lifecycle, reporting, and CI-friendly result comparison
- Single-consumer one-shot queue delivery; the first registrant executes locally while preserving
  existing lifecycle events

## Installation

Node `22.18+` is required.

### From public npm (recommended)

The framework is published to the public npm registry as `@qvac/test-suite`; no auth or registry config is needed.

```bash
npm install @qvac/test-suite
```

> Renamed from `@qvac/qvac-test-suite` in 0.11.0, when the framework moved into the
> [qvac monorepo](https://github.com/tetherto/qvac). The old package is deprecated but still installable;
> switch the specifier to `@qvac/test-suite` to pick up new releases.

### From GitHub Packages

Dev builds of the same framework are published to GitHub Packages as `@tetherto/test-suite-mono`. This path needs an `.npmrc` that points the `@tetherto` scope at GitHub Packages:

```text
@tetherto:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @tetherto/test-suite-mono
```

## Minimal desktop flow

### 1. Define tests

```ts
// tests/test-definitions.ts
import type { TestDefinition } from '@qvac/test-suite'

export const tests: TestDefinition[] = [
  {
    testId: 'api-create-user',
    params: { name: 'John', email: 'john@example.com' },
    expectation: { validation: 'type', expectedType: 'string' },
    metadata: { category: 'api', estimatedDurationMs: 5000 }
  }
]
```

### 2. Create a desktop consumer entry

```ts
// tests/desktop/consumer.ts
import { createExecutor } from '@qvac/test-suite'
import { ApiExecutor } from './executors/api-executor.js'

export const executor = createExecutor({
  handlers: [new ApiExecutor()]
})
```

### 3. Configure the framework

```js
// qvac-test.config.js
/** @type {import('@qvac/test-suite').QvacTestConfig} */
export default {
  mqtt: {
    broker: {
      protocol: { env: 'MQTT_PROTOCOL' },
      host: { env: 'MQTT_HOST' },
      port: { env: 'MQTT_PORT' }
    },
    username: { env: 'MQTT_USERNAME' },
    password: { env: 'MQTT_PASSWORD' }
  },
  testDir: './tests',
  consumers: {
    desktop: {
      platforms: ['macos'],
      entry: './tests/desktop/consumer.js',
      include: ['./src/**', './tests/**'],
      dependencies: 'auto'
    }
  }
}
```

The desktop `entry` should point to compiled JavaScript or another module format that plain Node can import in your repository setup.

### 4. Run locally

```bash
qvac-test run:local:desktop
```

This starts an embedded broker, runs the consumer and producer, and prints results. No external MQTT broker needed.

## Electron packaged app flow

Electron consumers run as packaged Electron Forge apps. The framework packages the configured app, launches the
packaged executable, and passes the test run context through `QVAC_TEST_*` environment variables.

The Electron app's main process owns the actual consumer bootstrap. It should read:

- `QVAC_TEST_RUN_ID` — run identifier shared with the producer
- `QVAC_TEST_CONFIG_DIR` — directory containing `qvac-test.config.js`
- `QVAC_TEST_CONSUMER_ENTRY` — absolute path to the configured Electron consumer entry
- `QVAC_TEST_MQTT_BROKER` — optional broker override from local orchestration

```js
// qvac-test.config.js
export default {
  testDir: './dist/tests',
  consumers: {
    electron: {
      platforms: ['macos'],
      entry: './dist/tests/electron/consumer.js',
      appDir: '.',
      appName: 'MyElectronConsumer',
      packageManager: 'npm',
      packageScript: 'package:electron'
    }
  }
}
```

```bash
qvac-test run:local:electron --filter completion-
```

Use `--skip-build` to relaunch an existing packaged app when only producer-side filters changed. With
`--skip-build`, the launcher requires an exact packaged output for the requested platform and architecture.

## Snap packaged app flow

Snap consumers package an Electron application in a strict Snap, install or refresh it from a local
artifact, and launch its configured app command. The consumer entry and config directory must be included
in the Snap because strict confinement cannot import arbitrary files from the host checkout. Electron is
the only supported Snap runtime in the current framework contract.

```js
export default {
  testDir: './dist/tests',
  consumers: {
    snap: {
      runtime: 'electron',
      entry: './app/resources/app/dist/tests/electron/consumer.js',
      appDir: '.',
      snapName: 'my-sdk-e2e',
      appCommand: 'my-sdk-e2e',
      artifactPath: './snap/dist/my-sdk-e2e.snap',
      snapConfigDir: './app/resources/app',
      packageManager: 'npm',
      packageScript: 'package:snap'
    }
  }
}
```

The package script owns Snapcraft configuration and must create the exact `artifactPath`. The framework
sets mounted `QVAC_TEST_CONFIG_DIR` and `QVAC_TEST_CONSUMER_ENTRY` paths under
`/snap/<snapName>/current`, strips host `QVAC_CONFIG_PATH`, and forwards the run ID and MQTT broker.

`run:local:snap` installs the artifact before starting the producer and removes it after the run. To avoid
replacing or purging user data, it refuses to install when the same Snap name is already present. Use
`--skip-snap-install` only when you intentionally want to run that existing installation.

The packaged Electron main process must import `QVAC_TEST_CONSUMER_ENTRY`. In normal mode it starts the
consumer; when `QVAC_TEST_MODE=bootstrap`, it calls the entry's exported `bootstrap()` function and exits
with its result. The framework launches through Xvfb when available and otherwise supplies Electron
headless flags.

```bash
qvac-test run:local:snap --filter snap-
qvac-test run:bootstrap:snap --skip-build --skip-snap-install
```

Snap build and execution require Linux, Snapcraft with a working LXD provider, snapd, and permission to
run `snap install`. Set `QVAC_TEST_SNAP_SUDO=0` when the current user can administer snaps without `sudo`.

<details>
<summary>Advanced: separate producer and consumer</summary>

If you need to run the producer and consumer in separate terminals (e.g. for debugging or remote broker setups):

```bash
# Terminal 1
qvac-test run:consumer:desktop --runId=test-123 --config=.

# Terminal 2
qvac-test run:producer --runId=test-123 --config=.
```

For Electron, package and launch the Electron app as the consumer:

```bash
# Terminal 1
qvac-test run:consumer:electron --runId=test-123 --config=.

# Terminal 2
qvac-test run:producer --runId=test-123 --config=.
```

</details>

## CLI commands

```bash
# Local orchestration (recommended)
qvac-test run:local:desktop
qvac-test run:local:electron
qvac-test run:local:snap
qvac-test run:local:android
qvac-test run:local:ios

# Separate producer / consumer (advanced)
qvac-test run:producer
qvac-test run:consumer:desktop --runId=<id>
qvac-test run:consumer:electron --runId=<id>
qvac-test run:consumer:snap --runId=<id>
qvac-test run:bootstrap:desktop
qvac-test run:bootstrap:electron
qvac-test run:bootstrap:snap

# Consumer builds
qvac-test build:consumer:electron
qvac-test build:consumer:snap
qvac-test build:consumer:android
qvac-test build:consumer:ios

# Result comparison
qvac-test report:compare --baseline baseline.json --current current.json --output comparison.json
qvac-test report:format --input comparison.json --format markdown --output comment.md
```

## Config notes

- `testDir` points to the directory containing `test-definitions.{js,ts}`
- Desktop consumers run their configured `entry` in place
- Electron consumers package and launch the configured Electron Forge app. The packaged app receives
  `QVAC_TEST_*` environment variables and should import/start the configured `entry` from its main process.
- Snap consumers build, install, and launch a Linux Snap whose packaged entry receives mounted
  `QVAC_TEST_*` paths.
- Mobile consumers use the `@qvac/test-suite/mobile` runtime and generated Expo scaffolding
- `.env` files are loaded automatically before config resolution

## Local development

This package lives in the [qvac monorepo](https://github.com/tetherto/qvac) at `packages/test-suite`. It has
no root workspace — install and build it on its own:

```bash
cd packages/test-suite
npm install
npm run check
npm run build
```

Its in-repo consumer is `packages/sdk/e2e`, which holds the SDK's e2e test definitions and
`qvac-test.config.js`.

## CI integration

CI orchestration is consumer-specific. This package provides the CLI and runtime pieces; the consumer owns
its workflow definitions, cache strategy, secrets wiring, and platform rollout.

In this monorepo that consumer is `.github/workflows/test-sdk.yml`, which builds the SDK e2e suite for
desktop, Electron, Snap, Android, and iOS. Its `test-suite-source` input selects where this framework comes
from for a given run:

- `manifest` — whatever `packages/sdk/e2e/package.json` declares (the default)
- `branch` — build and pack `packages/test-suite` from the checked-out ref, then install that tarball
- `npm` — resolve a published version or dist-tag via `test-suite-version`

Use `branch` to test an SDK change against an unreleased framework change without publishing.

## License

Apache-2.0. See [LICENSE](./LICENSE).
