import type { ChildInfo } from '@qvac/supervisor'
import type { SyncRuntimeDiagnostics } from './runtime-handle.ts'

export function toRuntimeDiagnostics(
  children: readonly ChildInfo[]
): SyncRuntimeDiagnostics {
  return {
    children: children.map(({ name, state, deps, info }) => {
      const details = normalizeInfo(info)
      return {
        name,
        state,
        deps,
        ...(details == null ? {} : { info: details })
      }
    })
  }
}

function normalizeInfo(info: unknown) {
  if (info == null || typeof info !== 'object') return null
  const discoveryTeardownComplete = Reflect.get(
    info,
    'discoveryTeardownComplete'
  )
  const topicPresent = Reflect.get(info, 'topicPresent')
  const networkInstanceId = Reflect.get(info, 'networkInstanceId')
  return {
    ...(typeof networkInstanceId === 'string' ? { networkInstanceId } : null),
    ...(typeof discoveryTeardownComplete === 'boolean'
      ? { discoveryTeardownComplete }
      : null),
    ...(typeof topicPresent === 'boolean' ? { topicPresent } : null)
  }
}
