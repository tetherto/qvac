# QVAC Test Suite v0.15.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.15.0

This release follows the SDK's move of its worker to bare-stow. The generated mobile consumer now targets Expo SDK 58, and external clients resolve their own Bare runtime.

---

## Breaking Changes

### The generated mobile consumer targets Expo SDK 58

`build:consumer:mobile` generates the app from the mobile consumer template, which now pins Expo SDK 58: `expo` `~58.0.23`, `react-native` `0.88.1`, `react` `19.3.0`, `react-native-bare-kit` `^0.17.1` and `react-native-worklets` `0.13.0`. `bare-runtime` is no longer a dependency of the app. Build mobile consumers against an `@qvac/sdk` that runs its worker on bare-stow; a project on an earlier SDK stays on `@qvac/test-suite` 0.14.x.

### External clients resolve their own Bare runtime

`BridgeExecutor` no longer resolves `bare-runtime-<platform>-<arch>` and no longer sets `QVAC_BARE_PATH` for the client it starts, and the `resolveBareFrom` option is removed from `BridgeExecutorOptions`. A client that needs a specific Bare binary gets it from its own SDK, or from `QVAC_BARE_PATH` set in the entry's `env`.

```typescript
// Before
new BridgeExecutor({
  interpreter,
  args,
  cwd,
  env,
  testDefinitions,
  log,
  resolveBareFrom: configDir
})

// After
new BridgeExecutor({ interpreter, args, cwd, env, testDefinitions, log })
```

---

## Changes

- The iOS build of the mobile consumer takes the Xcode scheme from the name of the workspace `expo prebuild` writes, instead of the first scheme `xcodebuild -list` prints. Local Swift packages the app links no longer get picked as the scheme.
- The Android memory worklet talks to the app over `Bare.IPC`, as `react-native-bare-kit` 0.17 provides it.
