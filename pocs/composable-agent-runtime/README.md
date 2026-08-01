# Composable Agent Runtime PoC

This private workspace tests the package and runtime boundaries proposed by the
Composable Agent Runtime QIP. It is evidence, not a production package source.

## Boundaries

- `@qvac/assistant` is the application facade and root lifecycle owner.
- `@qvac/sync` owns cryptographic device identity and replicated state.
- `@qvac/harness` owns ready-to-run agent execution.
- `@qvac/agents` contains transport-free agent primitives.
- `@qvac/sdk` owns inference through its standard public client and worker path.
- `@qvac/supervisor` supplies lifecycle mechanics without product policy.

Sync and Harness are siblings in Assistant's package and artifact hierarchy.
Their mobile worker entries, React Native launchers, and generated harnesses
remain package-owned. The Assistant Expo plugin composes those packages with
the existing SDK Expo plugin without reimplementing SDK bundling.

## Run the desktop slice

Install once from this directory:

```sh
bun install --ignore-scripts
```

Use separate commands so storage is closed and reopened between host runs:

```sh
node --experimental-strip-types apps/task-cli/index.ts seed --storage /tmp/qvac-task-poc --name Ada --age 37
node --experimental-strip-types apps/task-cli/index.ts observe --storage /tmp/qvac-task-poc --once
node --experimental-strip-types apps/task-cli/index.ts execute --storage /tmp/qvac-task-poc --trace
```

Run package, graph, clean-consumer, and type verification with:

```sh
bun run verify
```

## Run the mobile clean consumer

`apps/task-mobile` configures only `@qvac/assistant/expo-plugin`. It owns
pairing input, storage path, and UI state, not worker packaging, native linking,
or process isolation.

SDK 0.15 currently permits `bare-process@4.5.1`, whose native
`bare-signals@5` conflicts with SDK's `bare-signals@4`. `bare-tty@5.1.2`
introduces the same split through `bare-stdio`. Until the dependency ranges are
aligned, the application root must override `bare-process` to `4.5.0` and
`bare-tty` to `5.1.1`; final-artifact validation rejects the split if those
constraints are missing.

```sh
cd apps/task-mobile
npx expo prebuild --clean --platform android
npx expo run:android --device
```

The Android packaging PoC passed clean prebuild, debug APK validation, and a
physical arm64 device run on 2026-07-29. The device run covered Sync and
Harness readiness, restart, continued Sync writability, cancellation, and a
real Qwen completion through the Harness-to-SDK bridge.

After prebuild, validate the recorded execution realms and merged addon set:

```sh
bun run validate:artifacts --project-root apps/task-mobile
```

Validate an Android final artifact or a staged desktop distribution with:

```sh
bun run validate:artifacts --project-root apps/task-mobile --mode android --artifact apps/task-mobile/android/app/build/outputs/apk/debug/app-debug.apk --json /tmp/qvac-android-artifacts.json
bun run validate:artifacts --project-root apps/task-mobile --mode desktop --artifact /path/to/staged-dist --json /tmp/qvac-desktop-artifacts.json
```

The validator writes its complete JSON report to stdout and to `--json` when
provided. It exits nonzero for duplicate singleton versions within one realm,
native addon conflicts, linker-manifest drift, or missing staged prebuilds.

## Evidence policy

Fast tests use deterministic adapters. Separate integration tests exercise real
HRPC sessions, HyperDHT testnet replication, spawned Bare runtimes, and a
pre-provisioned Qwen model. A stub may not replace a boundary that the PoC
claims to validate.
