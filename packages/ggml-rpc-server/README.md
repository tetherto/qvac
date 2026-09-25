# @qvac/ggml-rpc-server

Managed wrapper for `ggml-rpc-server`.

This package ships the RPC server binary built from the same `qvac-fabric`
revision as the LLM client stack. The JavaScript API starts and stops the
server so applications do not need to invoke the CLI manually. Node uses the
packaged server executable; Bare on Android and iOS uses an in-process native
addon because mobile hosts cannot launch that executable as a child process.

Prebuild artifacts are produced for macOS arm64/x64, Linux arm64/x64, Windows
x64, Android arm64, and iOS arm64. Desktop prebuild jobs smoke-test both the
executable and in-process lifecycle paths; Android/iOS jobs cross-build the
same in-process addon for their physical ARM64 targets. RDMA remains Linux-only;
mobile builds use TCP.

```js
const { startRpcServer } = require('@qvac/ggml-rpc-server')

const server = await startRpcServer({ device: 'Vulkan0' })

try {
  console.log(server.url)
  console.log(server.runtime) // 'process' on Node, 'in-process' on mobile Bare
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

On Android and iOS, native server output is written to the host application's
platform log; `logs()` returns an empty string because there is no child-process
stdout stream to capture. Node continues to return the captured output tail.

## RDMA-capable builds

RDMA uses `qvac-fabric`'s existing `GGML_RPC_RDMA` support. It is opt-in at
build time with the `rpc-rdma` vcpkg feature and requires `libibverbs` from
rdma-core on Linux. Both the client-side `@qvac/llm-llamacpp` build and this
server package must be built with RDMA support; a server-only RDMA build will
fall back to TCP when the client is TCP-only.

The endpoint syntax does not change. Fabric auto-negotiates RDMA over the
existing RPC connection when both sides support it. To fail closed when the
managed server binary is expected to be RDMA-capable, pass `expectRdma: true`:

```js
const server = await startRpcServer({
  device: 'Vulkan0',
  host: '10.10.10.2',
  expectRdma: true,
  allowNonLoopbackHost: true
})

console.log(server.rdmaCapable)
```

Without `expectRdma`, startup does not scan the server binary or backend
libraries. `rdmaCapable` is `true` when startup logs report support and `null`
when capability was not checked; `null` does not mean RDMA is unavailable.
Pass `expectRdma: true` to check the packaged binary when the logs do not
report support, or reject startup if RDMA is unavailable.
