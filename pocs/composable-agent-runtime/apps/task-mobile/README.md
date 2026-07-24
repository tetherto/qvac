# Mobile runtime feasibility host

This private Expo host is limited to the physical-device feasibility gate. Real
Sync runs in its own BareKit Worklet with app-owned durable storage and HRPC to
Hermes. Harness remains an in-process lifecycle probe. On Android, SDK runs in
a private `:qvac_sdk` Service process; iOS retains the in-process SDK Worklet.
Run `build:worklets` before Metro to generate direct BareKit bundles.
Run `build:ios-addons` followed by `pod install` to link the native addons
discovered from the Sync and SDK bundle graphs into an iOS build.

## Android

Attach an Android 10 or newer device and run:

```sh
bun run android
```

The command rebuilds all Worklet bundles, links the discovered native addons
for every Android ABI, and invokes the Expo device build. BareKit requires
Android API 29 or newer.

Physical verification on a Pixel 9 Pro running Android 17 passed concurrent
Sync, Harness, and process-isolated SDK startup, protocol handshakes,
suspend/resume, writer admission, task replication, process-stop recovery, and
SDK-process crash recovery. The real Qwen desktop service completed the
phone-created task and replicated its result back to the app.

The automatic lifecycle probe is non-destructive. The explicit hard-crash
control starts a dedicated one-shot Worklet containing `bare-abort` inside the
SDK Service process. The main process controls the Service through AIDL and
relays runtime bytes through a reliable socket pair. Native abort terminates
only `:qvac_sdk`; Binder death and socket EOF move SDK to `DIED`, while Hermes,
Sync, and Harness remain alive. A subsequent start creates a new process and
completes a fresh protocol handshake.

Measured crash-isolation run:

- Host PID remained `3432`.
- SDK PID `3789` exited with `APP CRASH(NATIVE)` after signal 6.
- Restart created SDK PID `3952`.
- Restarted SDK returned to `READY` with a new runtime ID.
- Sync remained writable after the abort and SDK restart.

Measured on the physical device:

- Harness cold readiness: 722.3 ms; resume: 49.4 ms.
- Process-isolated SDK cold readiness: 591.7 ms; resume: 18.2 ms.
- Active Sync host: 338,341 KiB PSS and 475,348 KiB RSS.
- Backgrounded Sync host: 269,392 KiB PSS and 404,928 KiB RSS.
- Arm64 release APK: 108,054,236 bytes.
- Arm64 native libraries in the APK: 34 files totaling 88,243,800 bytes
  uncompressed.
- Worklet bundles: Sync 2,540,033 bytes, Harness 18,066 bytes, SDK 18,031
  bytes, and crash probe 3,720 bytes.

Do not treat simulator results as isolation evidence. Before any iOS command,
attach and unlock a physical iOS device, enable its developer settings, and
confirm the device is ready. The SDK hard-crash control invokes native
`abort()` through `bare-abort`. Physical-device verification confirms that it
terminates the host app because BareKit Worklets share the application process.

## Process-isolation result

Android now has a physically verified process boundary for the lightweight SDK
probe. The ordinary private Service shares the app UID, permissions, private
files, packaged native libraries, and network access, but has separate memory
and fatal-signal scope. It is not `isolatedProcess` and therefore is a crash
boundary, not a security sandbox. The core BareKit Java host must start the
Worklet before constructing host-side `IPC`, matching the native module's
ordering.

This does not yet prove production mobile inference. The gate still needs the
real SDK worker bundle, model loading, native inference addons, sustained
streaming, memory pressure, background-service policy, and bounded automatic
restart without replaying non-idempotent requests.

The iOS process-isolation gate found one supported candidate on iOS 26:
an Enhanced Security helper extension launched through `AppExtensionProcess`
and connected through XPC.

- BareKit implements Worklets as runtime threads in the application process.
  `terminate()` stops a Worklet normally, but a fatal signal terminates the
  process.
- Generic XPC services and arbitrary persistent helper processes are not
  available to normal third-party iOS applications.
- Enhanced Security helpers run separately and provide interruption reporting
  and process recreation. Apple does not document a memory budget or qualify
  them for multi-gigabyte Metal inference.
- Traditional app extensions have substantially lower memory limits,
  system-controlled lifetimes, and extension-specific purposes.
- Background tasks do not create a separate crash-isolated worker.

The abort control proves the blast radius of a fatal native error; it does not
simulate out-of-memory behavior. An allocation or model-load failure that
returns an error can be handled by unloading models or restarting a Worklet.
If iOS terminates the process for exceeding its memory limit, the entire app
dies. Supervisor cannot recover inside the terminated process.

This PoC includes an automated Enhanced Security helper probe with ping,
extension-side abort, interruption detection, host PID validation, and process
restart. The unsigned build passes, but the configured Personal Team cannot
provision the Enhanced Security capability, so the probe cannot yet be
installed on the physical device. A paid team with that capability must run
this gate before SDK and model dependencies are added.

The Xcode project already contains the probe target. If Expo regenerates the
native project, restore it with:

```sh
GEM_HOME=/opt/homebrew/Cellar/cocoapods/1.16.2_2/libexec \
  ruby scripts/configure-isolation-probe.rb
```

With an eligible signing team, launch the installed app without a debugger:

```sh
DEVICECTL_CHILD_QVAC_ISOLATION_PROBE=1 \
  xcrun devicectl device process launch \
  --device <DEVICE_ID> \
  --terminate-existing \
  --console \
  com.qvac.poc.composable-runtime
```

Success prints `QVAC_ISOLATION_PROBE_PASS` with distinct host, first-extension,
and restarted-extension PIDs.

Cold-ready and resume latency are captured in the UI. The worklet build writes
bundle byte counts to `generated/build-measurements.json`. Host memory, native
background retention, and model-load peak remain physical-device measurements.
