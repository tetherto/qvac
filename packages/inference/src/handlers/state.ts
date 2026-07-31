import type { StateResponse } from '@/schemas/index'
import { getLifecycleState } from '@/runtime/runtime-lifecycle'

export function handleState(): StateResponse {
  return {
    type: 'state',
    state: getLifecycleState()
  }
}
