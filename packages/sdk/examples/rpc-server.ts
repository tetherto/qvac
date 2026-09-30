// Install @qvac/ggml-rpc-server and rebuild the worker with
// rpcServerProvider: '@qvac/sdk/ggml-rpc-server/provider' in qvac.config.json.
// npx tsx rpc-server.ts 10.0.0.2 my-private-rpc-group
import { createInterface } from 'node:readline/promises'
import { startRpcServer, stopRpcServer, close } from '@qvac/sdk'

try {
  const host = process.argv[2]
  const topic = process.argv[3]
  if (!host || !topic) throw new Error('Usage: rpc-server.ts <private-ipv4> <topic>')
  const server = await startRpcServer({
    host,
    allowNonLoopbackHost: true,
    discoveryTopic: topic
  })
  const input = createInterface({ input: process.stdin, output: process.stderr })
  try {
    console.error(`▸ Serving ${server.url}; RDMA capable: ${server.rdmaCapable}`)
    await input.question('▸ Press Enter to stop after clients unload their models.\n')
  } finally {
    input.close()
    await stopRpcServer({ serverId: server.serverId })
  }
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  await close()
}
