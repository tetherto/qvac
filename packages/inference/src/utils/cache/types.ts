export interface CacheMessage {
  role: string
  content: string
  attachments?: { path: string }[] | undefined
  toolCalls?:
    { id?: string | undefined; name: string; arguments: Record<string, unknown> }[] | undefined
  toolCallId?: string | undefined
  toolName?: string | undefined
}
