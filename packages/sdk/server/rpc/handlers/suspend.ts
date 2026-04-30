import type { SuspendResponse } from "@/schemas";
import { suspendRuntime } from "@/server/bare/runtime-lifecycle";
import { LifecycleSuspendFailedError } from "@/utils/errors-server";

export async function handleSuspend(): Promise<SuspendResponse> {
  try {
    await suspendRuntime();
    return { type: "suspend" };
  } catch (error) {
    throw new LifecycleSuspendFailedError(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}
