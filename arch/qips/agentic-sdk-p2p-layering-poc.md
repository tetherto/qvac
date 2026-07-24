# Composable Agent Runtime PoC Evidence

## Purpose

This report records measured evidence for the package and runtime boundaries in
the [Composable Agent Runtime QIP](agentic-sdk-p2p-layering.md). The PoC is a
feasibility probe, not a production implementation.

## Source baselines

- QVAC monorepo and current SDK: `d4a4073de63457da6f5dc6987566fee5ea5bdb6f`
- Workbench `core-v2` Assistant/Harness source:
  `dcea141900df0e2117aeba69223ba2b54d2b0d6b`
- SDK split PR #3262:
  `edaa4d089efe08c6c90b4a4116c46e8b80d10c78` (open when the PoC started)
- Workbench `core-v2` Supervisor after PRs #1103 and #1161:
  `53ec6927f5707b5078d0ca41707559d9134b7e04`

## Claims under test

1. Sync, Harness, and SDK can run in independent Bare runtimes.
2. Generated typed contracts can isolate package ownership without dependency
   cycles.
3. Sync can operate alone and replicate app-owned records between peers.
4. Agents can operate as a transport-free library.
5. Harness can operate locally with in-memory state and no Sync runtime.
6. Assistant can provide one lifecycle over the full composition.
7. The application can own user and task semantics while QVAC supplies identity,
   replicated storage, orchestration, and inference.
8. SDK, Harness, and Sync failures can be contained at their declared runtime
   boundaries.
9. A physical iPhone can be admitted as a Sync writer, create app-owned tasks,
   and observe results produced by the desktop Harness and SDK composition.

## Known limits

- The passive second peer does not execute work. Claims, leases, fencing, and
  duplicate execution are not tested.
- Selective visibility, capability authorization, key epochs, and production
  secret storage are not tested.
- The SDK delegation migration is not tested.
- The current SDK uses `bare-rpc`; the PoC Harness-to-SDK HRPC adapter is an
  experimental boundary, not an existing SDK contract.
- The interactive Qwen path crosses separately spawned desktop Sync and Harness
  sidecars plus the current SDK worker. It does not prove claims, fencing,
  duplicate-execution prevention, or mobile inference.
- Physical iOS and Android verification observed pending and completed task
  snapshots. The partial-write path passes automated tests, but token-by-token
  mobile timing was not measured during the physical runs.
- iOS 26 provides an Enhanced Security helper-extension process boundary, but
  multi-gigabyte Metal inference is not qualified there. Physical validation is
  blocked because the configured Personal Team cannot provision the capability.
- The canonical Supervisor is adopted by Assistant, Sync, and Harness. Sync
  models its local metadata, identity Corestore, and replicated mesh/network as
  a dependency-ordered internal tree.
- Sync treats Hyperswarm, Mesh, PairingCoordinator, and replication wiring as
  one atomic network child. Independent internal restart, reload, and suspend
  behavior for those resources is not tested.

## Source deltas required by the PoC

- Sync update requests decode absent optional schema fields as `null`, not only
  `undefined`. Copying those `null` fields into a stored task caused
  Hyperdispatch string encoding to crash. The PoC now omits both forms and has
  regression coverage through status-only task updates.
- Real local DHT startup and reconnect can exceed Brittle's 30-second default.
  Replication assertions remain unchanged, but those two tests use an explicit
  120-second test budget.
- Bare does not provide the host `AbortController` global. Harness uses the
  Bare-compatible abort implementation through a runtime import map.
- Mobile Bare does not provide global `TextEncoder` or `TextDecoder`; Worklets
  import both from `bare-encoding`.
- The sidecar-oriented `bare-stow` child shim attaches `Bare.IPC`, while
  BareKit Worklets expose `BareKit.IPC`. The mobile probe uses direct bundles
  and runs its versioned protocol over Worklet IPC.
- iOS rejects dynamic loading of addon files from a Worklet bundle. The
  SDK-only `bare-abort` probe is emitted as a linked addon and vendored as an
  XCFramework.
- BareKit requires Android API 29. Expo's generated API 24 default must be
  raised with `expo-build-properties`.
- BareKit's default Android linker does not discover the PoC workspace's
  bundle-only addon graph. The Worklet build now emits a native-addon manifest,
  and the Android launcher links that exact set before the Gradle build.
- The destructive abort capability runs in a dedicated one-shot Worklet.
  Normal SDK startup and lifecycle probes do not load or invoke crash-only
  behavior.
- Pairing confirmation can arrive before the writer-admission Autobee update
  reaches the candidate. Sync now waits for its local writer to become writable
  before paired `ready()` resolves.
- Sync stores application tasks and internal Harness run records in the same
  replicated collection. Desktop and mobile adapters must project only their
  application task namespaces; otherwise internal event arrays appear as Qwen
  output.
- The initial `@qvac/runtime-contracts` package duplicated concerns already
  owned by each package's HRPC schema and runtime boundary. It was removed:
  Sync and Harness now own their wire types, errors, protocol information, and
  logging integration; Assistant owns composition compatibility and trace ID
  generation.

## Verification results

Results were reproduced on 2026-07-24 with `bun run verify` from
`pocs/composable-agent-runtime/` after the package-owned contract refactor. The full
command completed in 433 seconds with exit code 0. A missing result is not a
pass.

### Package graph and generated contracts

The following diagrams are authored as Mermaid and rendered to PNG:

- [Build dependency graph](images/agentic-sdk-p2p-layering-poc-build.png)
- [Runtime topology](images/agentic-sdk-p2p-layering-poc-runtime.png)
- [Task flow and ownership](images/agentic-sdk-p2p-layering-poc-task-flow.png)

All edges identify their interaction type. The build graph marks forbidden
directions, the runtime graph separates HRPC from the SDK adapter and native
calls, and the task flow keeps human profile and task policy in application
code.

Three static package tests with 51 assertions parse manifests and imports,
enforce exact private-package versions, reject product dependency cycles and
forbidden directions, and confirm that `@qvac/ai-sdk-provider` is absent from
the Bare runtime graph.

### Library suites

- Supervisor: 49 tests and 115 assertions pass under Node and Bare, covering
  bounded restart, concurrent failure reconciliation, reload, stow sidecars,
  nested entry escalation, and the mobile relay transport.
- Agents: 5 tests and 16 assertions pass under Node and Bare.
- App-owned task workflow: 2 Bun tests pass, including strict sequential
  execution and continue-after-failure policy.
- Sync: 9 tests and 47 assertions pass under Node and Bare. The suite covers
  local CRUD, identity persistence, real isolated-HyperDHT replication, offline
  edits, reconnect, passive-peer catch-up, writer admission, approval and
  rejection, one-time and expired invites, cross-writer updates, secret
  redaction, storage cleanup, its three-child nested resource tree, and
  immediate storage reopen after failed startup.
- Harness: 9 deterministic and HRPC tests with 33 assertions pass under Bun
  and Bare. Two additional spawned-sidecar tests pass through HRPC, including
  forced child termination without host termination.
- Assistant: 8 Vitest composition and compatibility tests pass, including
  recovery after a real Sync child process exit.
- Task CLI: 8 Vitest tests pass and the gated real-Qwen service test remains
  skipped by default. Coverage includes separate host processes, long-running
  service behavior, partial snapshots, stale work, and shutdown state.
- Current SDK worker recovery: the existing
  `packages/sdk/test/unit/worker-recovery.test.ts` baseline passes 1 test and 5
  assertions. It kills the first worker, observes `WORKER_CRASHED`, then proves
  a fresh worker PID serves the next call.

All six private packages were packed into tarballs. Clean temporary consumers
installed and imported Supervisor-only, Agents-only, Sync, Harness, and full
Assistant subsets without workspace state.

### Desktop compositions

- Supervisor with fake children: pass under Node and Bare.
- Agents with a deterministic model and no transport or storage: pass under
  Node and Bare.
- Sync alone, including local CRUD, offline startup, identity persistence, and
  two-peer replication: pass.
- SDK alone through its current client/worker path, including forced worker
  recovery with a fresh PID: pass.
- Harness with Agents and an injected SDK port, using in-memory state and no
  Sync: pass.
- Spawned Harness HRPC and spawned Sync HRPC: pass independently.
- Assistant state-only startup with durable state and a lazy SDK: pass.
- Clean facade-only installation of Assistant and its declared transitive
  stack: pass.
- Two application host processes seed and observe app-owned profile/task state,
  and the executor processes incomplete tasks sequentially: pass.
- Full deterministic Assistant task flow across separately spawned Sync,
  Harness, and SDK sidecars: pass. Integration assertions require three
  distinct non-host PIDs, runtime identities, a trace ID distinct from the run
  ID across both HRPC boundaries, durable persistence through Sync, lazy SDK
  startup, and reverse-order shutdown.
- Full real-model flow through the same desktop topology: pass in the physical
  desktop-to-iPhone task slice.

### Main-path infrastructure contracts

- `createAssistant()` now defaults durable storage to `.assistant`; callers can
  still override `storagePath`.
- Production composition defaults to Qwen 3.5 4B and its registry source.
  Deterministic inference remains an explicit test adapter.
- `assistant.run({ messages })` generates run and trace IDs and applies the
  default model. It returns a run handle with `id` and `traceId` that remains
  directly consumable with `for await`.
- `assistant.state` retains stable object identity, waits for readiness per
  operation, and resolves the latest Sync endpoint after supervised
  replacement. Active watch iterators do not reconnect silently.
- A top-level `logging.level` uses `@qvac/logging` and is propagated into
  spawned Sync and Harness runtimes. The spawned Sync suite confirms the
  configuration reaches the child. Library logs use stderr so application JSON
  on stdout remains stable.
- Runtime startup, compatibility, exit, and execution failures use
  package-owned `@qvac/error` codes. The Harness-owned HRPC schema carries its
  serializable error envelope with code, recovery intent, trace ID, boundary,
  and bounded causes. Child stdout and stderr are retained as local diagnostics
  but excluded from public error messages.
- Assistant creates or accepts one trace ID, Harness forwards it across HRPC,
  and the same ID reaches model load and completion on the SDK runtime port.
  Structured errors retain that ID on the response path.

### Failure containment

- Forced termination of spawned Sync leaves spawned Harness and the host alive:
  pass.
- Forced termination of spawned Harness leaves spawned Sync and the host alive:
  pass.
- Forced termination and recovery of the current SDK worker: pass in the
  existing SDK baseline test.
- Terminating the real Sync child in the full Assistant composition causes
  Supervisor to start a new Sync life and reconstruct Harness with new process
  IDs; a subsequent task run passes.
- A supervised SDK port restarts when its child exit promise settles and routes
  subsequent calls to the new runtime.
- Sync storage lock release after graceful and forced child shutdown: pass.
- Interrupted-work reporting without replay and the durable-mode no-downgrade
  invariant remain **not demonstrated**.

### Real-model task flow

The pre-provisioned cache artifact for
`QWEN3_5_4B_MULTIMODAL_Q4_K_M` was found without downloading. The initial
adapter incorrectly imported the worker-side plugin in the Node host and failed
with `Bare is not defined`. Using the current SDK client lets its existing
`bare-rpc` worker own plugin registration and native inference.

A manual focused one-turn Qwen smoke passed in 3.9 seconds. The first manual
sequential-task attempt exposed unbounded model reasoning filling the default
context window before the next task. An initial bounded-reasoning mitigation
allowed a manual two-task run to complete sequentially in 3.9 seconds with no
download.

After the canonical Supervisor and Sync subtree migration, a fresh two-task CLI
run loaded the pre-provisioned Qwen 3.5 4B model, executed tasks in order, and
persisted exact `FIRST` and `SECOND` results. The task workflow now sets
`reasoning_budget: 0`, keeping reasoning text out of application results. The
executor completed with two successful outcomes and exit code 0.

### Interactive desktop-to-iPhone task flow

On 2026-07-21, a physical iPhone 13 Pro joined a desktop-created Sync mesh from
a one-time `qvac-poc://pair` invite. The desktop displayed the candidate writer
fingerprint and released mesh material only after explicit terminal approval.
The mobile Sync Worklet did not report ready until the admitted Autobee writer
became locally writable.

The phone then created a task asking Qwen to write a C++ factorial function.
The desktop service received the replicated task, ran the pre-provisioned
Qwen 3.5 4B model through Harness and the current SDK worker, persisted the
terminal result, and replicated it back. The phone observed `pending` and
`completed` states and rendered the generated C++ response. Restarting the
desktop service reused the admitted writer and durable mesh without pairing
again.

This run exposed and fixed two integration defects: desktop task projection
initially ignored raw `phone-*` task IDs, and the mobile feed initially rendered
internal `@harness/*` run records. Regression coverage now verifies application
result projection and excludes internal run-state records.

### iOS gate

A release build passed on a physical iPhone 13 Pro. The Expo/BareKit host ran
Sync, Harness, and SDK concurrently as three named Worklets. Each completed the
versioned handshake with distinct runtime identity and trace metadata, then
passed host-driven suspend/resume:

- Sync cold readiness: 603 ms; resume: 1.13 ms.
- Harness cold readiness: 618 ms; resume: 0.57 ms.
- SDK cold readiness: 575 ms; resume: 0.80 ms.

The generated Worklet bundles are 17,833 bytes for Sync, 17,861 bytes for
Harness, and 19,673 bytes for SDK. The release app executable is 4,156,272
bytes and the complete `.app` bundle occupies 55,968 KiB.

Mobile packaging cannot use the sidecar-oriented `bare-stow` child shim because
it attaches `Bare.IPC`; BareKit Worklets expose `BareKit.IPC`. Direct bundles
and the versioned application protocol over Worklet IPC pass. iOS native addons
must be linked into the app binary, so the SDK-only `bare-abort` capability is
resolved as a linked addon rather than loaded from the bundle.

Worklets provide runtime and lifecycle separation, but not process crash
isolation. With all three Worklets ready, invoking native `bare-abort` from SDK
terminated the complete application with signal 6. Sync and Harness therefore
cannot survive a fatal native SDK failure in this in-process composition. This
remains the iOS result. The Android follow-up below moves SDK into a private
Service process and changes its fatal-signal scope.

### iOS process-isolation gate

The follow-up gate found one supported process-isolation candidate on iOS 26:
an Enhanced Security helper extension launched through `AppExtensionProcess`
and connected with `XPCSession`.

- The PoC installs `react-native-bare-kit` 0.14.5. Its React Native module owns
  `bare_worklet_t` handles directly inside the app, and BareKit starts each
  Worklet with `uv_thread_create`. `Worklet.terminate()` calls
  `bare_terminate`; it terminates the runtime thread, not an operating-system
  child process.
- Normal iOS applications still cannot use generic XPC services or arbitrary
  helper processes as persistent app-owned workers. Debugger-only behavior is
  not a distributable topology.
- App extensions are separate processes, but Apple assigns them substantially
  lower memory limits, short system-controlled lifetimes, and extension-specific
  purposes. Apple explicitly identifies resource-intensive functionality as
  appropriate for the containing app, not an extension. Apple does not qualify
  Enhanced Security helpers for multi-gigabyte Metal inference, so process
  isolation alone does not establish production viability.
- Background tasks schedule work for the application. They do not create a
  crash-isolated inference process.
- Another local app cannot provide a transparent persistent worker through
  generic XPC on iOS. Delegation to another device is a real process boundary,
  but it is remote inference rather than on-device inference.

The PoC now includes a minimal Enhanced Security extension and host probe. It
compiles successfully without signing and implements ping, extension-side
`abort`, interruption detection, host PID verification, process recreation,
and second-PID verification. The attached iPhone 13 Pro runs iOS 26.5.2 and is
eligible for the API.

Physical execution is blocked before installation. Automatic signing reports
that Personal development teams do not support the Enhanced Security
capability and cannot create a provisioning profile for the helper extension.
Therefore host survival and extension restart have not been measured. This is
an account capability blocker, not evidence that the process boundary fails.

Authoritative references:

- [BareKit 2.2.1 Worklet implementation](https://github.com/holepunchto/bare-kit/blob/6fd0cd175dc1458dd73dcc97e8528c78cecbd92e/shared/worklet.c)
- [React Native BareKit 0.14.5 native module](https://github.com/holepunchto/react-native-bare-kit/blob/19d41450fa48584dbc117df9834c8b273cbbed63/shared/BareKitModule.cc)
- [Apple: Creating Enhanced Security helper extensions](https://developer.apple.com/documentation/xcode/creating-enhanced-security-helper-extensions)
- [Apple: AppExtensionProcess](https://developer.apple.com/documentation/extensionfoundation/appextensionprocess)
- [Apple App Extension Programming Guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html)
- [Apple DTS: Using XPC on iOS](https://developer.apple.com/forums/thread/653405)

The gate decision remains open. Use a paid development team with the Enhanced
Security capability to run the existing abort-containment probe before adding
SDK or model dependencies. If that passes, the next gate must separately prove
model-file access, Metal availability, memory budget, sustained streaming, and
App Review viability. Until then, model-memory testing is deferred.

### Android gate

A debug and release build passed on a physical Pixel 9 Pro running Android 17.
The Expo/BareKit host ran Sync and Harness in the application process and SDK
in a private `:qvac_sdk` Service process. Harness and SDK completed the
versioned handshake, suspend, and resume sequence:

- Harness cold readiness: 722.3 ms; resume: 49.4 ms.
- Process-isolated SDK cold readiness: 591.7 ms; resume: 18.2 ms.

Real Sync admitted the phone as a writer over blind pairing. A task created in
the Android app replicated to the desktop service, was completed with the real
Qwen 3.5 4B model, and replicated back as a terminal task. Force-stopping and
relaunching the app restored the writable session and completed task without
pairing again.

The active Sync host measured 338,341 KiB PSS and 475,348 KiB RSS. After
backgrounding it measured 269,392 KiB PSS and 404,928 KiB RSS. The arm64
release APK is 108,054,236 bytes; its 34 arm64 native libraries total
88,243,800 uncompressed bytes. Current Worklet bundles are 2,540,033 bytes for
Sync, 18,066 bytes for Harness, 18,031 bytes for SDK, and 3,720 bytes for the
isolated crash probe.

The gate exposed two Android integration defects. Expo generated a minimum SDK
below BareKit's API 29 requirement, and the default BareKit Gradle linker
produced no workspace addon resources. The app now declares API 29 and links
the bundle-discovered addon manifest before building. This changed the Sync
startup failure from `ADDON_NOT_FOUND` for `libbare-path.3.1.1.so` to a
successful physical-device pairing and task flow.

The process-isolation follow-up added an unexported ordinary Android Service,
AIDL lifecycle control, and a reliable socket-pair data plane. It uses the core
BareKit Java `Worklet` and `IPC` host directly, without starting React Native in
the SDK process. The host starts the Worklet before constructing IPC, matching
the ordering used by the React Native BareKit bridge.

With host PID `3432` and SDK PID `3789`, the SDK handshake and suspend/resume
sequence passed. Starting the dedicated `bare-abort` Worklet then terminated
only `:qvac_sdk` with signal 6. Android recorded the exit as
`APP CRASH(NATIVE)`. The host PID remained `3432`, Harness stayed `READY`, Sync
stayed writable, and the broker reported SDK as `DIED` after socket EOF.
Restart created SDK PID `3952`, a new runtime ID, and a successful handshake.

This proves Android process crash containment, death reporting, and manual
restart for the lightweight SDK probe. It does not yet validate a real
model-loaded SDK worker, inference addons in the Service, background
foreground-service policy, memory pressure, or automatic replay-safe recovery.

## Conclusion

Desktop evidence supports the package graph, generated contracts, independent
Bare runtime mechanisms, replicated app-owned state, and sequential task
policy, automatic Sync/Harness reconstruction after child exit, current SDK
worker recovery, and the deterministic task flow across three separately
supervised sidecars. The main path now also demonstrates default storage,
shared logging, coded boundary errors, trace propagation, approved iPhone and
Android writer admission, and real-model desktop-to-phone task round trips.
Physical iOS and Android evidence supports concurrent BareKit runtimes,
host-owned lifecycle control, and durable app relaunch. In-process Worklets do
not contain native crashes. Android now proves a private Service process can
contain an SDK abort, report death, and restart a lightweight SDK runtime while
the host, Harness, and Sync survive. An iOS 26 Enhanced Security helper
compiles as a process-boundary candidate, but Personal Team provisioning blocks
physical execution and its inference resource limits remain unknown. Real
model-loaded Android isolation and numeric P9 budgets still require approval.
