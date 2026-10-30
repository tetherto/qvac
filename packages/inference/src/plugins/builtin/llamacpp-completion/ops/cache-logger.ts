import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

interface ChatMessage {
  role?: string
  content?: string | { type: string; text?: string; path?: string; content?: string }[]
  type?: string
  name?: string
}

/** A one-line summary of a message's content, parts included. */
function summarizeContent(content: ChatMessage['content']): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) =>
      part.type === 'text' ? (part.text ?? '') : `<media ${part.path ?? part.content ?? ''}>`
    )
    .join('')
}

function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role || m.type || '?'
      const summary = summarizeContent(m.content)
      const content = summary
        ? summary.length > 40
          ? summary.substring(0, 40) + '...'
          : summary
        : m.name || '(no content)'
      return `{${role}: "${content}"}`
    })
    .join(', ')
}

export function logCacheStatus(cacheKey: string, isReusing: boolean): void {
  const status = isReusing ? 'REUSING' : 'CREATING'
  logger.debug(`[kv-cache] [${cacheKey}] ${status} cache`)
}

export function logMessagesToAddon(
  messages: unknown[],
  phase: 'PROMPT_SEND' | 'NO_CACHE' = 'PROMPT_SEND'
): void {
  const typedMessages = messages as ChatMessage[]
  logger.debug(
    `[kv-cache] [${phase}] Sending ${typedMessages.length} msg(s): [${formatMessages(typedMessages)}]`
  )
}

export function logCacheDisabled(): void {
  logger.debug('[kv-cache] Cache disabled')
}

export function logCacheSave(sessionPath: string): void {
  logger.debug(`[kv-cache] Saving session: ...${sessionPath.slice(-20)}`)
}

export function logCacheSaveError(sessionPath: string, err: unknown): void {
  logger.warn(
    `[kv-cache] Failed to save session: ...${sessionPath.slice(-20)} — ${err instanceof Error ? err.message : String(err)}`
  )
}
