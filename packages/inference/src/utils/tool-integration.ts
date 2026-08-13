import type { Tool, ToolDialect } from '@/schemas/index'
import { detectToolDialectFromName } from '@/utils/tools/index'
import { getModelInfo } from '@/runtime/model-registry'

interface HistoryMessage {
  role: string
  content: string
  attachments?: { path: string }[] | undefined
}

/**
 * Prepend tools right after the system message (or at the very start when no
 * system message is present). The tool block stays in the kv-cache for the
 * whole chat session.
 */
export function prependToolsToHistory(
  history: HistoryMessage[],
  tools: Tool[]
): Array<HistoryMessage | Tool> {
  const systemMsgIndex = history.findIndex((msg) => msg.role === 'system')

  if (systemMsgIndex >= 0) {
    return [...history.slice(0, systemMsgIndex + 1), ...tools, ...history.slice(systemMsgIndex + 1)]
  }

  return [...tools, ...history]
}

export function detectToolDialect(modelId: string): ToolDialect {
  const info = getModelInfo(modelId)
  if (!info) return 'hermes'
  return detectToolDialectFromName(info.name, info.path)
}
