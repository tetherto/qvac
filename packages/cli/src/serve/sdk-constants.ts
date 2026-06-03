import * as sdk from '@qvac/sdk'
import type { ModelConstant } from '@qvac/sdk'

/**
 * Walks every export of `@qvac/sdk` and indexes the `ModelConstant`-shaped
 * ones by their `name`. Cheap (sync iteration over the SDK's exports), no I/O,
 * idempotent — callers are free to invoke it on each use rather than
 * threading the resulting map around.
 */
export function loadModelConstants (): Map<string, ModelConstant> {
  const map = new Map<string, ModelConstant>()
  for (const value of Object.values(sdk)) {
    if (isModelConstant(value)) map.set(value.name, value)
  }
  return map
}

function isModelConstant (value: unknown): value is ModelConstant {
  return (
    value !== null &&
    typeof value === 'object' &&
    'src' in value &&
    'name' in value &&
    'addon' in value
  )
}
