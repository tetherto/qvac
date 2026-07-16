import { normalizeAssistantCacheContent } from '../cache-normalize.ts'
import type { CacheMessage } from './types.ts'

function normalizeAssistantMessage(message: CacheMessage): CacheMessage {
  if (message.role !== 'assistant') {
    return message
  }
  return { ...message, content: normalizeAssistantCacheContent(message.content) }
}

export function getAutoCacheLookupHistory(currentHistory: CacheMessage[]): CacheMessage[] {
  if (currentHistory.length <= 1) {
    return []
  }

  return currentHistory.slice(0, -1).map(normalizeAssistantMessage)
}

export function buildAutoCacheSaveHistory(
  currentHistory: CacheMessage[],
  assistantResponse: string
): CacheMessage[] {
  return [
    ...currentHistory,
    {
      role: 'assistant',
      content: normalizeAssistantCacheContent(assistantResponse)
    }
  ]
}
