import type { StateResponse } from '../../schemas'
import { getLifecycleState } from '../runtime-lifecycle'

export function handleState(): StateResponse {
  return {
    type: 'state',
    state: getLifecycleState()
  }
}
