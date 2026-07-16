import type { SuspendResponse } from '../schemas/index.ts'
import { suspendRuntime } from '../runtime/runtime-lifecycle.ts'
import { LifecycleSuspendFailedError } from '../errors/index.ts'

export async function handleSuspend(): Promise<SuspendResponse> {
  try {
    await suspendRuntime()
    return { type: 'suspend' }
  } catch (error) {
    throw new LifecycleSuspendFailedError(
      error instanceof Error ? error.message : String(error),
      error
    )
  }
}
