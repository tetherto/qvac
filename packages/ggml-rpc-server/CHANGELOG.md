# Changelog

## [0.6.0] - 2026-10-20

### Changed

- `@qvac/fabric` dependency bumped `^0.22.0` -> `^0.23.0`, which carries
  `qvac-fabric` `11018.2.0` -> `11259.0.0`, a rebase onto upstream llama.cpp
  b11259 ([#5171](https://github.com/tetherto/qvac/pull/5171)). A caret on a
  `0.x` version locks the minor, so `^0.22.0` would not have resolved `0.23.0`
  on its own. The native API changes, so the native addon is rebuilt against
  the 0.23.0 headers.
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.23.0` together.
- No API change for this package. The RPC protocol stays at 111, so servers on
  this release still pair with clients on `@qvac/fabric` 0.22.0.

## [0.5.1] - 2026-10-15

### Fixed

- On Windows, the addon now binds the delay-loaded `@qvac/fabric` runtime
  when it loads, so a first fabric call on a worker thread cannot fail with
  `0xC06D007E` ([#5121](https://github.com/tetherto/qvac/pull/5121)). Loading throws an error naming the fabric
  module if the bind fails.

## [0.5.0] - 2026-10-15

### Changed

- Without a `port`, the native server binds a free port itself and reports it,
  instead of this package picking a free port and releasing it before the
  server bound it. Another process could take the port in between, which showed
  up as a rare `RpcServerStartError`. `allocateFreePort()` is still exported.
- `rdmaCapable` and `expectRdma` now use the capability that `@qvac/fabric`
  reports, replacing a search of the RPC module for a log line. They mean the
  server will try RDMA, which on Linux also needs `libibverbs.so.1` installed,
  an RDMA device, and `GGML_RPC_NO_RDMA` unset. A host with the library but no
  RDMA device now reports `rdmaCapable: false`, so `expectRdma: true` fails
  closed there.
- Requires `@qvac/fabric` 0.22.0, whose RPC backend exports
  `ggml_backend_rpc_server_get_port` and `ggml_backend_rpc_rdma_supported`.
  A mobile app that still installs `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` 0.21 fails to start the server with
  `RpcServerStartError`.

## [0.4.0] - 2026-10-14

### Changed

- `@qvac/fabric` dependency bumped `^0.21.1` -> `^0.22.0`, which carries
  `qvac-fabric` `11018.1.0#1` -> `11018.2.0`. A caret on a `0.x` version
  locks the minor, so `^0.21.1` would not have resolved `0.22.0` on its own.
  `GGML_MAX_NAME` is now 128, so the native addon is rebuilt against the
  0.22.0 headers.
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.22.0` together.
- The RPC protocol moves 109 -> 111, so a server built against this release
  only talks to clients on `@qvac/fabric` 0.22.0. On Linux the server loads
  without libibverbs and uses TCP, and a malformed endpoint port is rejected
  instead of binding a different port.

## [0.3.0] - 2026-10-14

### Breaking

- An explicit `backendsDir` is scanned as given. It is no longer a prebuilds
  root with `<host>/qvac__fabric` appended. Omit it and `@qvac/fabric` locates
  the backends it ships, next to its runtime.

### Changed

- `@qvac/fabric` dependency bumped `^0.20.0` -> `^0.21.1`, whose platform
  packages are now ordinary addons. This package declares them itself: the
  desktop ones as `optionalDependencies`, and `@qvac/fabric-android-arm64` and
  `@qvac/fabric-ios` as optional `peerDependencies`.
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.21.1` together.

## [0.2.0] - 2026-10-06

### Changed

- `@qvac/fabric` dependency bumped `^0.19.0` -> `^0.20.0`, which carries
  `qvac-fabric` `10549.5.0` -> `11018.0.0`, the rebase onto upstream llama.cpp
  b11018. This package consumes the shared runtime via npm rather than building
  the vcpkg port, so the range bump is what picks up the new fabric. A caret on
  a `0.x` version locks the minor, so `^0.19.0` would not have resolved `0.20.0`
  on its own. The RPC protocol stays at 109, so servers and clients on
  fabric 10549.3.0 and later still connect, and servers now keep backend
  tensor extras. No API change.
- The server lifecycle moved into `rpc-server-core`, which now has C++ unit
  tests, and the package gained desktop integration tests
  ([#4769](https://github.com/tetherto/qvac/pull/4769)).
- Mobile apps must move `@qvac/fabric` and `@qvac/fabric-android-arm64` or
  `@qvac/fabric-ios` to `0.20.0` together.

## [0.1.1] - 2026-09-30

### Changed

- `@qvac/fabric` dependency bumped `^0.18.1` -> `^0.19.0`, and the mobile
  `@qvac/fabric-android-arm64` and `@qvac/fabric-ios` pins `0.18.1` ->
  `0.19.0`. This carries `qvac-fabric` `10549.4.0` -> `10549.5.0`, whose RPC
  change matters here: idle RDMA and tensor-dispatch threads now sleep instead
  of spinning, so an idle server no longer keeps cores busy. A caret on a `0.x`
  version locks the minor, so `^0.18.1` would not have resolved `0.19.0` on
  its own. No API change.

## 0.1.0

- Add the managed `ggml-rpc-server` API as an in-process Bare addon backed by
  the npm `@qvac/fabric` package.
- Report through `rdmaCapable` whether the installed Fabric RPC backend was
  built with RDMA, and reject `expectRdma: true` when it was not.
- Report native start and stop failures as typed errors extending
  `RpcServerNativeError` (`RpcServerDeviceError`, `RpcServerCacheError`,
  `RpcServerStartError`, `RpcServerBackendError`, `RpcServerStopError`).
- Build prebuild artifacts for macOS arm64/x64, Linux arm64/x64, Windows x64, Android arm64, and iOS arm64.
