# Changelog

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
