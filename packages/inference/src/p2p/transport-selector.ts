import type { Request } from '../schemas/index.ts'
import type { HandlerEntry } from '../handlers/types.ts'

export function shouldUseStreamErrorTransport(
  entry: HandlerEntry | undefined,
  rawRequest: Record<string, unknown> | undefined
): boolean {
  if (!entry) return false
  if (entry.type === 'stream') return true
  if (entry.type !== 'reply') return false
  if (rawRequest?.['withProgress'] !== true) return false

  try {
    return typeof entry.supportsProgress === 'function'
      ? entry.supportsProgress(rawRequest as Request)
      : !!entry.supportsProgress
  } catch {
    return !!entry.supportsProgress
  }
}
