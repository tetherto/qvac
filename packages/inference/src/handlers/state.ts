import type { StateResponse } from '../schemas/index.ts'
import { getLifecycleState } from '../runtime/runtime-lifecycle.ts'

export function handleState(): StateResponse {
  return {
    type: 'state',
    state: getLifecycleState()
  }
}
