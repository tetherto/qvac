# Changelog

## 0.1.0

- Add the managed `ggml-rpc-server` API as an in-process Bare addon backed by
  the npm `@qvac/fabric` package.
- Report through `rdmaCapable` whether the installed Fabric RPC backend was
  built with RDMA, and reject `expectRdma: true` when it was not.
- Report native start and stop failures as typed errors extending
  `RpcServerNativeError` (`RpcServerDeviceError`, `RpcServerCacheError`,
  `RpcServerStartError`, `RpcServerBackendError`, `RpcServerStopError`).
- Build prebuild artifacts for macOS arm64/x64, Linux arm64/x64, Windows x64, Android arm64, and iOS arm64.
