// Run: bare examples/rpc-server.ts [topic]
// Choose an interface explicitly: bare examples/rpc-server.ts <private-ipv4> <topic>
// LAN announcements require a Wi-Fi or Ethernet address on the same subnet as callers.
// Requires: npm install @qvac/inference @qvac/ggml-rpc-server
import { registerRpcServerProvider, startRpcServer, stopRpcServer, close } from '@qvac/inference'
import { ggmlRpcServerProvider } from '@qvac/inference/ggml-rpc-server/provider'

registerRpcServerProvider(ggmlRpcServerProvider)
try {
  const host = Bare.argv[3] ? Bare.argv[2] : undefined
  const topic = Bare.argv[3] ?? Bare.argv[2]
  const server = await startRpcServer(
    topic ? { ...(host ? { host } : {}), discoveryTopic: topic, allowNonLoopbackHost: true } : {}
  )
  try {
    console.log(`▸ Serving ${server.url}; RDMA capable: ${server.rdmaCapable}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10000))
  } finally {
    await stopRpcServer({ serverId: server.serverId })
  }
} finally {
  await close()
}
