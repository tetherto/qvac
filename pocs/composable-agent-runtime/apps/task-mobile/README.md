# Task mobile

This Expo app is the clean consumer proof for the composed Assistant stack. The
application owns only product input: its Sync storage location, a pairing URI,
and task UI lifecycle.

`@qvac/assistant/expo-plugin` is the only Expo plugin configured by the app. It
packages the package-owned Sync and Harness workers via their contributor-mode
plugins, delegates standard SDK packaging to `@qvac/sdk/expo-plugin`, and links
the merged native addon set. The app has no local worker bundles, Metro asset
rules, linker scripts, or native process-isolation integration.

Standalone Sync or Harness apps configure only `@qvac/sync/expo-plugin` or
`@qvac/harness/expo-plugin` instead. Those plugins own their worker packaging
and linker finalization without Assistant composition.

## Run

From the PoC root, install dependencies and run the debug app on an attached
Android device:

```sh
bun install
bun run android
```

The command clean-prebuilds the Android project, builds and installs the debug
app, launches it, and starts Metro. The following narrower commands are also
available:

```sh
bun run android:prebuild
bun run android:build
bun run android:release
bun run android:release:device
```

`android:build` produces
`apps/task-mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
`android:release` produces
`apps/task-mobile/android/app/build/outputs/apk/release/app-release.apk`.
The demo release uses the Android debug signing key and does not require Metro.

The controller stays idle on a first launch until a user provides a valid
pairing URI. After a successful connection, it writes a local pairing marker so
later launches can reconnect the saved session. Running tasks display a
Cancel task action, which aborts the Assistant run and persists `cancelled`.
