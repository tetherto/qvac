import type { PingResponse } from "@/schemas";

export function handlePing(): PingResponse {
  return { type: "pong", number: Math.random() * 100 };
}
