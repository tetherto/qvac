# @qvac/ggml-rpc-server

Managed in-process GGML RPC server for Bare applications.

The package loads the RPC backend supplied by `@qvac/fabric` and starts it
through a native addon. It does not bundle or launch llama.cpp's
`ggml-rpc-server` CLI executable.

Prebuild artifacts are produced for macOS arm64/x64, Linux arm64/x64, Windows
x64, Android arm64, iOS arm64, and the iOS simulator on arm64/x64. Desktop
prebuild jobs smoke-test the in-process lifecycle path; Android/iOS jobs
cross-build the same addon for their targets.

```js
const { startRpcServer } = require('@qvac/ggml-rpc-server')

const server = await startRpcServer({ device: 'Vulkan0' })

try {
  console.log(server.url)
  console.log(server.rdmaCapable)
} finally {
  await server.stop()
}
```

Without a `port`, the server binds a free port itself and reports it in
`server.port`, so no other process can take the port before the server binds
it. `allocateFreePort()` only finds a port that is free now; prefer leaving
`port` unset.

The listener accepts IPv4 addresses; `localhost` is normalized to `127.0.0.1`.
The default host is `127.0.0.1`, but loopback is not private to the host
application: other local processes (including apps with local TCP access on
Android and iOS) can connect. The underlying RPC listener has no authentication
and serves one client at a time, so another local client can occupy the server
and block the intended client. Start it only when needed, stop it after use,
and do not treat loopback binding as an access-control boundary. Non-loopback
hosts are rejected unless `allowNonLoopbackHost: true` is passed; use them only
on a trusted/private network with external access controls.

With `cache: true`, the server stores tensor data sent by clients in a local
cache directory, so any client that can connect can write to that directory.
Combined with a non-loopback host, that is unauthenticated disk writes from the
network; enable the cache only for clients you trust.

Like a listening `net.Server`, a running server keeps the process alive until
`stop()` resolves, so a standalone worker can start it and wait for clients.

Native server output is written to the host application's platform log.

## Errors

Errors are classes that can be matched by `name` or `instanceof`. Invalid
options throw `RpcServerInvalidHostError`, `RpcServerNonLoopbackHostError`,
`RangeError` (port) or `TypeError` (threads); `allocateFreePort()` throws
`RpcServerPortAllocationError` when it cannot find a port; and
`expectRdma: true` when the server would not try RDMA throws
`RpcServerRdmaUnavailableError`. Failures reported by the native server
extend `RpcServerNativeError`, which carries the native error as `cause` and a
`code` equal to its `name`:

| Error | When |
|---|---|
| `RpcServerDeviceError` | No requested device exists, or no device is available |
| `RpcServerCacheError` | The cache directory cannot be resolved or created |
| `RpcServerStartError` | The server cannot be created or bound, the RPC backend is missing, or the installed `@qvac/fabric` is too old |
| `RpcServerBackendError` | The Fabric backends directory is invalid or cannot be inspected |
| `RpcServerStopError` | The server does not stop cleanly |

Anything else from the native addon, such as an out-of-memory failure, is
rethrown unchanged.

## RDMA on Linux

The Linux RPC backend in `@qvac/fabric` is built with RDMA and loads
`libibverbs.so.1` (`libibverbs1` on Debian/Ubuntu) at runtime. When the library
is installed, the server tries RDMA with each client that also supports it and
falls back to TCP otherwise. Without the library, the server runs over TCP
only. RDMA also requires the provider package for the host's hardware.

`rdmaCapable` reports whether the server will try RDMA: the library loaded and
`GGML_RPC_NO_RDMA` is not set. `rdmaCapable: true` does not guarantee that a
given connection uses RDMA, since the client and the link must support it too.
Android, iOS, macOS and Windows always report `false`.

To fail closed when RDMA is required, pass `expectRdma: true`. Startup rejects
with `RpcServerRdmaUnavailableError` when the server would not try RDMA:

```js
const server = await startRpcServer({
  device: 'Vulkan0',
  host: '10.10.10.2',
  expectRdma: true,
  allowNonLoopbackHost: true
})

console.log(server.rdmaCapable)
```

Without `expectRdma`, the server starts either way and reports in
`rdmaCapable` whether it will try RDMA.

## Testing

```bash
npm run test:unit          # JS unit tests against a mocked binding
npm run test:cpp           # C++ unit tests (GoogleTest)
npm run test:integration   # desktop integration tests against prebuilds/
```

On a PR, `on-pr-nx.yml` runs the C++ tests with the `run-cpp-addon-tests` label
and the desktop integration tests with the `run-desktop-addon-tests` label. Their
platforms and runner setup live in the `test:cpp` and `test:integration`
targets of `project.json`.
