// Run: bare examples/rpc-server.ts [topic]
// Explicit address selection also supports renamed adapters: bare examples/rpc-server.ts <private-ipv4> <topic>
// LAN announcements require a Wi-Fi or Ethernet address on the same subnet as callers.
// Requires: npm install @qvac/inference @qvac/ggml-rpc-server
import {
  registerRpcServerProvider,
  startRpcServer,
  stopRpcServer,
  rpcServerStatusStream,
  close
} from '@qvac/inference'
import AbortController from 'bare-abort-controller'
import { ggmlRpcServerProvider } from '@qvac/inference/ggml-rpc-server/provider'

registerRpcServerProvider(ggmlRpcServerProvider)
try {
  const host = Bare.argv[3] ? Bare.argv[2] : undefined
  const topic = Bare.argv[3] ?? Bare.argv[2]
  const options = topic
    ? {
        ...(host ? { host, lanAddresses: [host] } : {}),
        discoveryTopic: topic,
        allowNonLoopbackHost: true
      }
    : {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = await startRpcServer(options)
    const health = new AbortController()
    let restart = false
    const monitor = (async () => {
      for await (const status of rpcServerStatusStream(
        { serverId: server.serverId },
        { signal: health.signal }
      )) {
        console.log(`▸ Advertising ${status.advertisement}: ${status.reason}`)
        if (status.error) console.error(status.error)
        if (status.recovery === 'restart') restart = true
      }
    })()
    void monitor.catch(() => {})
    try {
      console.log(`▸ Serving ${server.url}; RDMA capable: ${server.rdmaCapable}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 10000))
    } finally {
      health.abort(undefined)
      try {
        await monitor
      } finally {
        await stopRpcServer({ serverId: server.serverId })
      }
    }
    if (!restart) break
    if (attempt === 1) throw new Error('RPC advertising failed after one restart')
    console.log(
      '▸ Restarting after advertising failure. Clients must rediscover before loading models.'
    )
  }
} finally {
  await close()
}
