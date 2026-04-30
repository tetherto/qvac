import type { HeartbeatResponse } from "@/schemas";

export function handleHeartbeat(): HeartbeatResponse {
  return { type: "heartbeat", number: Math.random() * 100 };
}
