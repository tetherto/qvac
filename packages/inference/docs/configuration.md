# Configuration

The configuration schema lives in `src/schemas/config.ts`; resolution and runtime
state live in their neighboring configuration and runtime modules. The SDK consumes
the exported inference surface rather than maintaining an independent schema.

- Resolve and validate configuration before exposing it to handlers.
- Keep runtime configuration immutable unless a public API explicitly defines a
  reload operation.
- Add a field to its schema, resolved state, public type surface, and focused tests
  together.
- Use cross-platform path and environment handling compatible with Bare and the SDK
  hosts.
- Never put credentials or machine-specific values in committed defaults or
  examples.

Read the current source before documenting defaults; configuration fields and
defaults are intentionally not duplicated here.

## Native RPC configuration

For `llamacpp-completion`, `rpc-servers` is a comma-separated endpoint list and
`devices` is an explicit ordered native device list. The transform forwards both
strings unchanged. Native `RPC0`, `RPC1`, and later names follow endpoint
registration order. `tensor-split` weights follow the explicit device order. The
addon validates device existence, split support, and weights. RPC loads retain
`split-mode` and `tensor-split` on mobile; local-only mobile loads retain the
existing single-GPU guard. An explicit remote-only device list must fail when
remote placement is unavailable, rather than selecting a local CPU.

Managed server options are defined in `src/schemas/rpc-server.ts`. Omitting `host`
keeps the managed package's loopback default. A non-loopback bind requires
`allowNonLoopbackHost: true`. `discoveryTopic` separately opts into advertising and
requires a concrete RFC1918 IPv4 address. Hostnames, wildcard, public, link-local,
and loopback addresses cannot be advertised. IPv6 advertising is not supported
by the current native server contract.

Discovery hashes the topic with the `qvac:ggml-rpc-discovery:v1` domain prefix and
a zero-byte separator using SHA-256. Announcements are newline-delimited JSON
with `version: 1` and a `url`, bounded to 1024 bytes. Advertisers refresh each
second; lookups expire a candidate after three seconds without a refresh or when
its connection closes. Lookups retain no shared candidate cache, limit peers and
probes, and probe TCP reachability within the search budget. Candidates carry no
authentication or compatibility guarantee. The application must select and order
them before loading.

The server path is lazy and uses the native package's Bare export on every SDK
worker platform. The returned runtime is `in-process` and `rdmaCapable` is false.
These APIs are library-only in this release; CLI orchestration is outside the
SDK-to-SDK implementation plan.

## RPC development inputs and validation

This checkout includes the unmerged native prerequisites unchanged from their
upstream revisions:

- LLM client PR #4527, `768528943d33658df84944bc59302507621440c0`, applied to the current
  `@qvac/llm-llamacpp` 0.54.0 package.
- Managed server PR #4516, `732cab595f3d8296e14a375657c0c19146ab3e46`, package version 0.1.0.
- Fabric `v10549.3.0`, commit `33f5bb6fd978f74232d30dd46e9bb8f423ad8971`, packaged by
  vcpkg PR #378, merge `35d35950439d9df14ab92a8ee3a3bd67383ab2d0`. The LLM package uses
  the existing shared `@qvac/fabric` 0.17.0 dependency.
- Native CI PR #4537 was inspected at `fbcdc8e10ecca166032193cf0e44289d59a1507e`.
  Its workflow changes remain in that prerequisite PR.

The RPC server has no npm release yet. For local validation, the SDK/e2e build's
`--native-source` option builds and packs Fabric, the LLM client, and the RPC
server from this checkout, then installs their tarballs with package overrides.
It restores the manifests afterward. Plain installs still use the declared npm
ranges, which do not establish that the published LLM package contains RPC
support. Publish compatible native packages and update the ranges before
releasing inference; publish inference before the SDK release consumes its new
contract.

Focused tests cover schemas and forwarding, server ownership, rollback, stop
failures, TCP readiness probes, versioned discovery frames, deduplication, stale
and closed peers, unreachable endpoints, cancellation, and suspend/resume.
SDK e2e definitions use `rpc-server-` and register a shared executor for desktop,
mobile, and Electron/Snap, without a smoke tag. Build from local native source:

```sh
cd packages/sdk/e2e
npm run install:build:full -- --native-source
npx qvac-test run:local:desktop --filter rpc-server-
npx qvac-test run:local:electron --skip-install --filter rpc-server-
npx qvac-test run:local:android --filter rpc-server-
npx qvac-test run:local:ios --filter rpc-server-
```

The source build targets the current host. Mobile runs also need device prebuilds
in the native packages before packing.

Hardware validation remains required for mobile serving and initiation, native
client connection release on unload and termination, mismatched builds, restart,
and network loss during generation. On three machines, verify native placement
logs for layer and tensor loads with two selected remote devices. Check tensor
server-to-server ports and `GGML_RPC_NO_COMM=1`. Record model, native revisions,
endpoint/device order, connection and load time, first-token latency, generation
rate, and peak memory for wired and trusted private wireless runs. Unit tests and
TCP reachability alone do not verify GPU placement or these performance claims.

Local validation on macOS arm64 passed 130 focused inference tests, including
real TCP probes and an empty Hyperswarm lookup; 33 SDK contract/error tests;
and 29 upstream managed-server unit tests. The generated Python RPC tests and
error tests passed. SDK typecheck/build, inference and SDK lint, generated
contract checks, Python generation checks, and frozen-lockfile validation passed.
The e2e executor typechecked against the rebuilt SDK.

Fabric, the LLM client, and the RPC server built from source on macOS arm64 with
Fabric 10549.3.0. Inference and SDK builds and both packages' typechecks passed
using the local native tarballs. The LLM binding and Fabric loaded under Bare.
Both server smoke tests passed the RPC handshake and CPU device enumeration;
the Bare test also verified unknown-device rejection. A direct SDK worker test
passed two-server start/stop, empty discovery, unknown-server rejection, and
unsafe-advertisement rejection using the source-built server.

The full native-source SDK/e2e build passed with the e2e override to patched
`tar@7.5.22`. All four RPC cases passed on desktop and all four passed in packaged
Electron, with no skips. Source-build failure tests verify manifest and local
lockfile restoration. Repository frozen-lockfile verification also passed.
No distributed GPU run, mobile runtime, Snap runtime, or placement and
performance result is claimed by this local validation.
