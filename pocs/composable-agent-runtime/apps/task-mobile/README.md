# Mobile runtime feasibility host

This private Expo host is limited to the physical-device feasibility gate. Its
Hermes runner broker creates independent BareKit Worklets named `Sync`,
`Harness`, and `SDK`. Run `build:worklets` before Metro to generate direct
BareKit bundles. Run `build:ios-addons` followed by `pod install` to link the
SDK-only native abort probe into an iOS build.

Do not treat simulator results as isolation evidence. Before any iOS command,
attach and unlock a physical iOS device, enable its developer settings, and
confirm the device is ready. The SDK hard-crash control invokes native
`abort()` through `bare-abort`. Physical-device verification confirms that it
terminates the host app because BareKit Worklets share the application process.

Cold-ready and resume latency are captured in the UI. The worklet build writes
bundle byte counts to `generated/build-measurements.json`. Host memory, native
background retention, and model-load peak remain physical-device measurements.
