import type { ResumeResponse } from '../schemas/index.ts'
import { resumeRuntime } from '../runtime/runtime-lifecycle.ts'
import { LifecycleResumeFailedError } from '../errors/index.ts'

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
