import type { RpcDevice, RpcServerCandidate } from '@/schemas/rpc-server'

export type RpcDeviceMapping = RpcDevice & { url: string; alias: string }

/**
 * Pass exactly this load's rpc-servers endpoints in the same order, even on
 * reused workers. Aliases enumerate every device in that order, starting at RPC0
 * for each load. Use the aliases to select devices; tensor-split weights follow
 * the selected devices order. Repeated endpoints are skipped by this helper,
 * but rpc-servers must contain unique endpoints. Discovery does not register devices.
 */
export function getRpcDeviceMap(servers: readonly RpcServerCandidate[]): RpcDeviceMapping[] {
  const seen = new Set<string>()
  const result: RpcDeviceMapping[] = []
  for (const server of servers) {
    if (seen.has(server.url)) continue
    seen.add(server.url)
    for (const [index, device] of server.devices.entries()) {
      if (device.index !== index) throw new Error('RPC inventory must be in native device order')
      result.push({ ...device, url: server.url, alias: `RPC${result.length}` })
    }
  }
  return result
}
