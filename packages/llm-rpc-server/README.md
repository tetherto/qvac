# @qvac/ggml-rpc-server

Managed process wrapper for `ggml-rpc-server`.

This package ships the RPC server binary built from the same `qvac-fabric`
revision as the LLM client stack. The JavaScript API starts, waits for, logs,
and stops the server process so applications do not need to invoke the CLI
manually.

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

The default host is `127.0.0.1`. Non-loopback hosts are rejected unless
`allowNonLoopbackHost: true` is passed because the underlying RPC listener does
not provide authentication. Only use non-loopback hosts on a trusted/private
network with external access controls.

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
