import type { HeartbeatResponse } from '../schemas/index.ts'

export function handleHeartbeat(): HeartbeatResponse {
  return { type: 'heartbeat', number: Math.random() * 100 }
}
