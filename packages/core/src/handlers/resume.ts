import type { ResumeResponse } from '../schemas'
import { resumeRuntime } from '../runtime/runtime-lifecycle'
import { LifecycleResumeFailedError } from '../errors'

export async function handleResume(): Promise<ResumeResponse> {
  try {
    await resumeRuntime()
    return { type: 'resume' }
  } catch (error) {
    throw new LifecycleResumeFailedError(
      error instanceof Error ? error.message : String(error),
      error
    )
  }
}
