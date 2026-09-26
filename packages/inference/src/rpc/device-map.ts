import type { RpcDevice, RpcServerCandidate } from '@/schemas/rpc-server'

export type RpcDeviceMapping = RpcDevice & { url: string; alias: string }

/**
 * Map every endpoint's devices in native first-registration order.
 * For a fresh worker, pass the chosen rpc-servers order. For a reused worker,
 * include all previously registered endpoints first, in their original order.
 * Discovery itself does not register native devices. Restarted servers require
 * a fresh worker if their inventory changed, because native registrations persist.
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
