# @qvac/ggml-rpc-server

Managed in-process GGML RPC server for Bare applications.

The package loads the RPC backend supplied by `@qvac/fabric` and starts it
through a native addon. It does not bundle or launch llama.cpp's
`ggml-rpc-server` CLI executable.

Prebuild artifacts are produced for macOS arm64/x64, Linux arm64/x64, Windows
x64, Android arm64, iOS arm64, and the iOS simulator on arm64/x64. Desktop
prebuild jobs smoke-test both the in-process lifecycle path; Android/iOS jobs
cross-build the same addon for their targets.

```js
const { startRpcServer } = require('@qvac/ggml-rpc-server')

const server = await startRpcServer({ device: 'Vulkan0' })

try {
  console.log(server.url)
  console.log(server.runtime) // 'in-process'
  console.log(server.rdmaCapable)
} finally {
  await server.stop()
}
```

The listener accepts IPv4 addresses; `localhost` is normalized to `127.0.0.1`.
The default host is `127.0.0.1`, but loopback is not private to the host
application: other local processes (including apps with local TCP access on
Android and iOS) can connect. The underlying RPC listener has no authentication
and serves one client at a time, so another local client can occupy the server
and block the intended client. Start it only when needed, stop it after use,
and do not treat loopback binding as an access-control boundary. Non-loopback
hosts are rejected unless `allowNonLoopbackHost: true` is passed; use them only
on a trusted/private network with external access controls.

Like a listening `net.Server`, a running server keeps the process alive until
`stop()` resolves, so a standalone worker can start it and wait for clients.

Native server output is written to the host application's platform log;
`logs()` returns an empty string because there is no child-process stdout
stream to capture.

## Linux requirements

The Linux RPC backend in `@qvac/fabric` links `libibverbs.so.1`, so Linux
hosts must provide it (`libibverbs1` on Debian/Ubuntu) even when connections
use TCP. Without it, `startRpcServer()` rejects with an error whose `code` is
`RpcServerStartError`.
RDMA also requires the provider package for the host's hardware.

## RDMA-capable builds

On Linux (not Android), `rdmaCapable` reports whether the installed
`@qvac/fabric` RPC backend was built with RDMA. Such a backend negotiates RDMA
with each client that also supports it and falls back to TCP otherwise, so
`rdmaCapable: true` does not guarantee that a given connection uses RDMA. Other
platforms always report `false`.

To fail closed when RDMA is required, pass `expectRdma: true`. Startup rejects
with `RpcServerRdmaUnavailableError` when the installed backend lacks RDMA:

```js
const server = await startRpcServer({
  device: 'Vulkan0',
  host: '10.10.10.2',
  expectRdma: true,
  allowNonLoopbackHost: true
})

console.log(server.rdmaCapable)
```

Without `expectRdma`, the server starts either way and reports the backend's
capability in `rdmaCapable`.

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
