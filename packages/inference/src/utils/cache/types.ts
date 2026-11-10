import type { HistoryContent } from '@/schemas/completion-stream'

export interface CacheMessage {
  role: string
  content: HistoryContent
  attachments?: { path: string }[] | undefined
  toolCalls?:
    { id?: string | undefined; name: string; arguments: Record<string, unknown> }[] | undefined
  toolCallId?: string | undefined
  toolName?: string | undefined
}
