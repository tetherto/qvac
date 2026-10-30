import { discoverRpcEndpoints } from '@/rpc/discovery'
import { createRequestRegistry } from '@/runtime/request-context'

const registry = createRequestRegistry()
await using ctx = await registry.begin({ requestId: 'child-lookup', kind: 'rpcDiscovery' })
const result = await discoverRpcEndpoints(Bare.argv[2]!, 2200, ctx)
console.log(JSON.stringify(result.map(({ url }) => url).sort()))
