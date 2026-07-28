# TD: iOS SDK Crash Isolation

## Problem

BareKit Worklets are separate runtimes on threads inside the iOS application
process. A fatal native SDK failure such as `abort`, a segmentation fault, or
jetsam terminates the host application together with Sync and Harness.
Supervisor can restart a Worklet after a recoverable runtime failure, but it
cannot recover after the operating system terminates the shared process.

iOS 26 Enhanced Security helper extensions provide a supported process
boundary through `AppExtensionProcess` and XPC. The PoC includes a minimal
abort, interruption, and restart probe that compiles without signing. Physical
verification is blocked because the available Personal Team cannot provision
the Enhanced Security capability, while the available Tether developer role
does not grant Certificates, Identifiers & Profiles access. Multi-gigabyte
model residency, Metal inference, XPC streaming, and App Review viability also
remain unverified.

## Recommended Solution

Host the SDK inference runtime in an iOS 26 Enhanced Security helper extension.
Keep lifecycle ownership in the application, communicate through a versioned
XPC contract, detect process death through `onInterruption`, and apply bounded
restart plus explicit model reload without replaying in-flight requests.

Validate the design in gates:

1. Obtain an eligible organization signing team and provision the Enhanced
   Security extension.
2. Run the existing abort probe on a physical device and prove that the host,
   Sync, and Harness survive while the helper restarts with a new PID.
3. Package the real SDK worker and native inference addons in the helper, then
   verify model-file access, Metal availability, and sustained event streaming.
4. Load Qwen 3.5 2B Q4_K_M followed by Parakeet, measuring cold-download,
   warm-cache, peak-memory, unload, crash, and restart behavior.
5. Validate the signed build through TestFlight and confirm that the extension
   resource limits and review policy support production inference.

If the helper cannot satisfy the inference workload, explicitly narrow iOS
containment to recoverable SDK errors and app relaunch, or use delegated
inference on another device.
