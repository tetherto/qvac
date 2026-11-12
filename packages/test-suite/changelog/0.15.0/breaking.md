# 💥 Breaking Changes v0.15.0

## Run the SDK worker on bare-stow

PR: [#5186](https://github.com/tetherto/qvac/pull/5186)

The SDK now runs its worker on bare-stow. This package changed with it in two places.

### The generated mobile consumer targets Expo SDK 58

`build:consumer:mobile` generates the app from `templates/mobile-consumer`, which now pins Expo SDK 58: `expo` `~58.0.23`, `react-native` `0.88.1`, `react` `19.3.0`, `react-native-bare-kit` `^0.17.1` and `react-native-worklets` `0.13.0`. `bare-runtime` is no longer a dependency of the app. Build mobile consumers against an `@qvac/sdk` that runs its worker on bare-stow; a project on an earlier SDK stays on `@qvac/test-suite` 0.14.x.

**BEFORE:**

```json
"expo": "~54.0.10",
"react-native": "^0.81.5",
"react-native-bare-kit": "^0.16.0",
"bare-runtime": "^1.24.2"
```

**AFTER:**

```json
"expo": "~58.0.23",
"react-native": "0.88.1",
"react-native-bare-kit": "^0.17.1"
```

### External clients resolve their own Bare runtime

`BridgeExecutor` no longer resolves `bare-runtime-<platform>-<arch>` and no longer sets `QVAC_BARE_PATH` for the client it starts. The `resolveBareFrom` option is removed from `BridgeExecutorOptions`. A client that needs a specific Bare binary gets it from its own SDK, or from `QVAC_BARE_PATH` set in the entry's `env`.

**BEFORE:**

```typescript
new BridgeExecutor({
  interpreter,
  args,
  cwd,
  env,
  testDefinitions,
  log,
  resolveBareFrom: configDir
})
```

**AFTER:**

```typescript
new BridgeExecutor({ interpreter, args, cwd, env, testDefinitions, log })
```

---
