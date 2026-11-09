import { normalizeAssistantCacheContent } from '@/utils/cache-normalize'
import type { CacheMessage } from '@/utils/cache/types'

export function normalizeCacheMessage(message: CacheMessage): CacheMessage {
  const { attachments, ...normalized } = message
  // Content parts are a user-turn shape (the schema rejects them elsewhere);
  // assistant text is always a plain string.
  if (message.role === 'assistant' && typeof message.content === 'string') {
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
