// Discovery requires the same multicast-capable Wi-Fi or Ethernet link and IPv4 subnet.
// Rebuild the worker with
// rpcServerProvider: '@qvac/sdk/ggml-rpc-server/provider' in qvac.config.json.
// npx tsx rpc-server.ts my-private-rpc-group
// Explicit address selection also supports renamed adapters: npx tsx rpc-server.ts 10.0.0.2 my-private-rpc-group
import { createInterface } from 'node:readline/promises'
import { startRpcServer, stopRpcServer, rpcServerStatusStream, close } from '@qvac/sdk'

try {
  const host = process.argv[3] ? process.argv[2] : undefined
  const topic = process.argv[3] ?? process.argv[2]
  if (!topic) throw new Error('Usage: rpc-server.ts [private-ipv4] <topic>')
  const options = {
    ...(host ? { host, lanAddresses: [host] } : {}),
    allowNonLoopbackHost: true,
    discoveryTopic: topic
  }
  let server = await startRpcServer(options)
  const health = new AbortController()
  const monitor = (async () => {
    for await (const status of rpcServerStatusStream({}, { signal: health.signal })) {
      if (status.serverId !== server.serverId) continue
      console.error(`▸ Advertising ${status.advertisement}: ${status.reason}`)
      if (status.error) console.error(status.error)
      if (status.recovery === 'restart') {
        console.error(
          '▸ Unload client models, then enter r to stop and restart. Clients must rediscover.'
        )
      }
    }
  })()
  void monitor.catch(() => {})
  const input = createInterface({ input: process.stdin, output: process.stderr })
  try {
    console.error(`▸ Serving ${server.url}; RDMA capable: ${server.rdmaCapable}`)
    while (
      (await input.question(
        '▸ Enter r to restart after clients unload, or press Enter to stop.\n'
      )) === 'r'
    ) {
      await stopRpcServer({ serverId: server.serverId })
      server = await startRpcServer(options)
      console.error(`▸ Serving ${server.url}; clients must rediscover.`)
    }
  } finally {
    input.close()
    health.abort()
    try {
      await monitor
    } finally {
      await stopRpcServer({ serverId: server.serverId })
    }
  }
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  await close()
}
