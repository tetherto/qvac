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
} finally {
  await server.stop()
}
```

The default host is `127.0.0.1`. Non-loopback hosts are rejected in this
initial package because the underlying RPC listener does not provide
authentication.
