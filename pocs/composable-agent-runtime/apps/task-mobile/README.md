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

Install dependencies from the PoC root:

```sh
bun install --ignore-scripts
```

Then use the standard Expo flow:

```sh
cd apps/task-mobile
npx expo prebuild --clean --platform android
npx expo run:android --device
```

The controller stays idle on a first launch until a user provides a valid
pairing URI. After a successful connection, it writes a local pairing marker so
later launches can reconnect the saved session. Running tasks display a
Cancel task action, which aborts the Assistant run and persists `cancelled`.

Final prebuild and device validation are intentionally outside this task.
