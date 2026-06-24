import type { StateResponse } from "@/schemas";
import { getLifecycleState } from "@/server/bare/runtime-lifecycle";

export function handleState(): StateResponse {
  return {
    type: "state",
    state: getLifecycleState(),
  };
}
