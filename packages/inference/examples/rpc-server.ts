// Run: bare examples/rpc-server.ts
// Requires: npm install @qvac/inference @qvac/ggml-rpc-server@0.2.0
import { registerRpcServerProvider, startRpcServer, stopRpcServer, close } from '@qvac/inference'
import { ggmlRpcServerProvider } from '@qvac/inference/ggml-rpc-server/provider'

registerRpcServerProvider(ggmlRpcServerProvider)
try {
  const server = await startRpcServer()
  try {
    console.log(`▸ Serving ${server.url}; RDMA capable: ${server.rdmaCapable}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10000))
  } finally {
    await stopRpcServer({ serverId: server.serverId })
  }
} finally {
  await close()
}
