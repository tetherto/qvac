import { TOOL_SEARCH_NAME, executeToolSearch, type Tool, type ToolCall } from '@qvac/sdk'

/**
 * Cap on how many times one HTTP request will let the model search before the
 * turn is answered as it stands. A model that keeps searching without calling
 * anything would otherwise hold the connection open indefinitely.
 */
export const MAX_TOOL_SEARCH_ROUNDS = 4

type HistoryMessage = { role: string; content: string }

type DrainedTurn = {
  toolCalls: ToolCall[]
  finishReason: 'stop' | 'length' | 'tool_calls'
}

/**
 * Drop any `tool_search` call still on the turn and recompute the finish
 * reason. Only reachable when the round cap ended the loop mid-search: the
 * client has no handler for the SDK's own tool, so surfacing it would strand
 * the conversation.
 */
export function stripToolSearchCalls<T extends DrainedTurn>(drained: T): T {
  const toolCalls = drained.toolCalls.filter((call) => call.name !== TOOL_SEARCH_NAME)
  if (toolCalls.length === drained.toolCalls.length) return drained
  return {
    ...drained,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
  }
}

/**
 * Fold a turn's `tool_search` calls into the conversation.
 *
 * `tool_search` is the SDK's own tool — an HTTP client has no handler for it —
 * so serve runs it here and asks the model again, and only tool calls the
 * client can actually execute ever reach the response.
 *
 * Returns `null` when the turn asked for no search, which is every turn of a
 * request that declares no deferred tools, and also when the turn mixed a
 * search with a call the client must run: continuing would drop that call, and
 * only the client can answer it. Such a turn is returned as it stands, with the
 * search dropped by `stripToolSearchCalls`; the model searches again on the
 * next request, which is what a fresh request does anyway.
 */
export function foldToolSearch(
  tools: Tool[] | undefined,
  history: HistoryMessage[],
  toolCalls: ToolCall[],
  assistantText: string
): HistoryMessage[] | null {
  const searches = toolCalls.filter((call) => call.name === TOOL_SEARCH_NAME)
  if (searches.length === 0) return null
  if (searches.length !== toolCalls.length) return null

  // The assistant turn goes back verbatim so the model sees its own call
  // syntax on the replay.
  let extended: HistoryMessage[] = [...history, { role: 'assistant', content: assistantText }]
  for (const call of searches) {
    extended = [
      ...extended,
      { role: 'tool', content: executeToolSearch(tools ?? [], call.arguments, extended) }
    ]
  }
  return extended
}
