# Composable Agent Runtime PoC

This private workspace tests the package and runtime boundaries proposed by the
Composable Agent Runtime QIP. It is evidence, not a production package source.

## Boundaries under test

- `@qvac/assistant` is the application facade and root lifecycle owner.
- `@qvac/sync` owns cryptographic device identity and replicated state.
- `@qvac/harness` owns ready-to-run agent execution.
- `@qvac/agents` contains transport-free agent primitives.
- `@qvac/sdk` or `@qvac/core` owns inference inside an isolated Bare runtime.
- `@qvac/supervisor` contains lifecycle mechanics without product policy.

The task application owns human profile fields, task schemas, ordering, and
completion policy. QVAC packages do not infer those domain semantics.

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

The real-model smoke is explicit and never downloads:

```sh
node --experimental-strip-types apps/task-cli/index.ts seed --storage /tmp/qvac-task-qwen --name Ada --age 37
bun run --cwd apps/task-cli smoke:qwen -- --storage /tmp/qvac-task-qwen --trace
```

Run package, graph, clean-consumer, and type verification with:

```sh
bun run verify
```

## Run the physical-iOS gate

Prepare direct BareKit Worklet bundles and link the SDK crash-probe addon:

```sh
cd apps/task-mobile
bun run build:worklets
bun run build:ios-addons
```

Then vendor the generated XCFramework:

```sh
cd ios
pod install
cd ..
```

Build for an attached device, substituting local signing and device values:

```sh
xcodebuild -workspace ios/ComposableRuntimeFeasibility.xcworkspace -scheme ComposableRuntimeFeasibility -configuration Release -destination 'id=<DEVICE_UDID>' -allowProvisioningUpdates DEVELOPMENT_TEAM=<APPLE_TEAM_ID> CODE_SIGN_STYLE=Automatic build
```

The iOS host uses the versioned application protocol directly over
`BareKit.IPC`. The sidecar-oriented `bare-stow` child shim uses `Bare.IPC` and
is not compatible with Worklets. The measured gate confirms three concurrent
Worklets and host-owned lifecycle control, but native SDK abort terminates the
whole app because Worklets share its process.

## Evidence policy

Fast tests use deterministic adapters. Separate integration tests exercise real
HRPC sessions, HyperDHT testnet replication, spawned Bare runtimes, crash
containment, and a pre-provisioned Qwen model. A stub may not replace a boundary
that the PoC claims to validate.
