import type { SuspendResponse } from '@/schemas/index'
import { suspendRuntime } from '@/runtime/runtime-lifecycle'
import { LifecycleSuspendFailedError } from '@/errors/index'

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
