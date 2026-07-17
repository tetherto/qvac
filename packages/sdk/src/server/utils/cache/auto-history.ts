import { normalizeAssistantCacheContent } from '@/utils/cache-normalize'
import type { CacheMessage } from './types'

function normalizeCacheMessage(message: CacheMessage): CacheMessage {
  const { attachments, ...normalized } = message
  if (message.role === 'assistant') {
    normalized.content = normalizeAssistantCacheContent(message.content)
  }
  return {
    ...normalized,
    ...(attachments && attachments.length > 0 ? { attachments } : {})
  }
}

export function getAutoCacheLookupHistory(currentHistory: CacheMessage[]): CacheMessage[] {
  if (currentHistory.length <= 1) {
    return []
  }

  return currentHistory.slice(0, -1).map(normalizeCacheMessage)
}

export function buildAutoCacheSaveHistory(
  currentHistory: CacheMessage[],
  assistantResponse: string
): CacheMessage[] {
  return [
    ...currentHistory.map(normalizeCacheMessage),
    normalizeCacheMessage({
      role: 'assistant',
      content: assistantResponse
    })
  ]
}
