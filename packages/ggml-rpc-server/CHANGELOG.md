# Changelog

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
