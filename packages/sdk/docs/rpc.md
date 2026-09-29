# Managed RPC servers

Use `startRpcServer` to serve local devices, `discoverRpcServers` to find idle
servers, and `getRpcDeviceMap` to select their devices for an LLM load. Applications
choose the discovery topic, endpoint order, and server lifetime. No CLI orchestration
is provided.

## Install and configure

Serving applications must install `@qvac/ggml-rpc-server@0.1.0` explicitly. It is an
optional peer of inference and the SDK, so applications that only run models or
discover servers do not need it. Distributed LLM loads require
`@qvac/llm-llamacpp@0.55.0`; `0.54.x` rejects `rpc-servers` and `devices`.
These examples use `@qvac/fabric@0.18.1` on both client and server.

For a Node, Electron, or Expo serving application, add this to `qvac.config.json`
before bundling its worker:

```json
{
  "rpcServerProvider": "@qvac/sdk/ggml-rpc-server/provider"
}
```

Rebuild the worker after installing the addon. Rebuild native mobile applications
too, so their linked addons include the server and matching Fabric prebuilds.
The SDK e2e app declares the server directly and includes this provider in both its
desktop/mobile and Electron configurations.

Bare applications register the provider explicitly:

```ts
import { registerRpcServerProvider } from '@qvac/inference'
import { ggmlRpcServerProvider } from '@qvac/inference/ggml-rpc-server/provider'

registerRpcServerProvider(ggmlRpcServerProvider)
```

Serving and discovery do not require a model plugin. The initiating worker needs
the LLM plugin to load a model.

## Serving and selection

The default bind address is loopback. To advertise, supply a concrete private IPv4
address, `allowNonLoopbackHost: true`, and a shared `discoveryTopic`. Wildcard and
loopback addresses cannot be advertised. Native traffic is unencrypted and
unauthenticated; discovery topics do not authenticate participants. Keep this on
a trusted private network. Enabling `cache` lets connecting clients write tensor
data into the native cache directory.

Discovery probes candidates over TCP and returns devices in native enumeration
order with memory snapshots. A server serves one client at a time, so busy or
unreachable servers may be absent. Results are candidates, not reservations.

Sort and select endpoints once, then pass exactly that list to `getRpcDeviceMap`
and `rpc-servers`. Aliases start at `RPC0` for every load, including on reused
workers. Do not prepend endpoints from previous loads. Each endpoint can expose
multiple devices. `devices` selects aliases in order, and `tensor-split` weights
follow that selected order. Duplicate `rpc-servers` endpoints are rejected.

On mobile, RPC loads retain explicit `devices`, `split-mode`, and `tensor-split`;
`main-gpu` is removed because the native client rejects it with RPC placement.

`startRpcServer` returns an owned `serverId`, endpoint URL, `runtime: 'in-process'`,
and the native `rdmaCapable` flag. Linux RDMA-capable backends negotiate RDMA with
capable clients and fall back to TCP otherwise. Inventory probes use TCP even
when the server supports RDMA. Linux RDMA builds require `libibverbs.so.1`.

Stop a server on the SDK instance that started it. `stopRpcServer` withdraws its
advertisement and waits for native shutdown. `close` also stops owned servers.
Unload models on the initiating instance before stopping their remote servers.
Pending starts and discovery calls expose `requestId` for targeted `cancel` calls.

## Examples and platform coverage

- [SDK serving](../examples/rpc-server.ts) starts a server until Enter is pressed.
- [SDK initiating](../examples/rpc-inference.ts) discovers servers, selects devices,
  and streams a completion with cleanup.
- [Bare serving](../../inference/examples/rpc-server.ts) registers the provider directly.
- [Python](../../sdk-python/examples/rpc_servers.py) starts and stops a server or
  lists discovered devices. Python serving needs a worker bundled with the provider
  and addon above; a default worker does not register it.

The native server publishes macOS arm64/x64, Linux arm64/x64, Windows x64,
Android arm64, and iOS arm64 builds. The SDK consumer tests exercise lifecycle,
discovery, cancellation, invalid inputs, and device mapping on desktop, Electron,
and mobile. Test registration does not imply every platform was run locally.

Earlier source-build validation covered macOS and Electron, plus iPhone and
Samsung serving with Mac-initiated layer splitting. It does not validate this
published dependency set on those phones. Tensor splitting, phone-initiated
inference, mismatched native builds, and network fault injection remain unverified
on physical devices. Check the PR validation results for the platforms rerun with
the published packages.
