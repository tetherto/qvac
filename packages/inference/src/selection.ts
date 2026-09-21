import type { Request } from '@/schemas/index'
import type { HandlerEntry } from '@/handlers/types'

export function selectHandler(entry: HandlerEntry): HandlerEntry['handler'] {
  return entry.handler
}

export function handlerSupportsProgress(entry: HandlerEntry, request: Request): boolean {
  return !!(
    'withProgress' in request &&
    request.withProgress &&
    (typeof entry.supportsProgress === 'function'
      ? entry.supportsProgress(request)
      : entry.supportsProgress)
  )
}
