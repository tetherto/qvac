import type { Tool } from '@/schemas/tools'
import { validateTools, type ToolInput } from '@/utils/tool-helpers'

/**
 * Reserved name of the built-in search tool. A caller cannot register a tool
 * under this name, and it is never itself deferred — the model needs one
 * callable entry point to reach everything else.
 */
export const TOOL_SEARCH_NAME = 'tool_search'

const DEFAULT_SEARCH_LIMIT = 3
const MAX_SEARCH_LIMIT = 8

// Ceiling on the definitions one search may append. A query matching a dozen
// large schemas would otherwise undo the saving the catalog just made.
const MAX_DEFINITION_BYTES = 8 * 1024

export type HistoryMessage = {
  role: string
  content: string
}

/**
 * Envelope written as the `tool` result of a `tool_search` call. It is also
 * what a later turn reads back to learn which definitions this conversation
 * already carries, so the field order is fixed and the shape is stable across
 * versions: the same search on the same inventory must produce byte-identical
 * content or the KV prefix diverges.
 */
type ToolSearchResult = {
  tool_search: {
    query: string
    loaded: string[]
    already_loaded: string[]
    hint?: string
  }
  tools: Tool[]
}

// Fixed text, so a repeated no-match search stays byte-identical and cannot
// move the KV divergence point.
const NO_MATCH_HINT =
  'No tool matched. Search again with a different capability word, or answer without a tool.'

export function isDeferred(tool: Tool): boolean {
  return tool.deferLoading === true
}

export function partitionTools(tools: readonly Tool[]): {
  alwaysLoaded: Tool[]
  deferred: Tool[]
} {
  const alwaysLoaded: Tool[] = []
  const deferred: Tool[] = []
  for (const tool of tools) {
    if (isDeferred(tool)) deferred.push(tool)
    else alwaysLoaded.push(tool)
  }
  return { alwaysLoaded, deferred }
}

/** Strip the registration-only fields so what reaches the model is a plain definition. */
function toWireTool(tool: Tool): Tool {
  const { deferLoading: _deferLoading, group: _group, ...wire } = tool
  return wire
}

/**
 * Compact listing of the deferred inventory: one line per tool, name and
 * description only, grouped by `group` where present.
 *
 * Caller order is preserved and groups appear in first-use order, because this
 * text sits in the prompt prefix — a reordering between turns would move the
 * divergence point and cost a re-prefill.
 */
export function buildCatalog(deferred: readonly Tool[]): string {
  const ungrouped: Tool[] = []
  const groups = new Map<string, Tool[]>()

  for (const tool of deferred) {
    if (tool.group === undefined) {
      ungrouped.push(tool)
      continue
    }
    const existing = groups.get(tool.group)
    if (existing) existing.push(tool)
    else groups.set(tool.group, [tool])
  }

  const lines: string[] = []
  const describe = (tool: Tool) => `- ${tool.name}: ${tool.description}`
  for (const tool of ungrouped) lines.push(describe(tool))
  for (const [group, tools] of groups) {
    lines.push(`[${group}]`)
    for (const tool of tools) lines.push(describe(tool))
  }
  return lines.join('\n')
}

/**
 * The built-in search tool, carrying the catalog in its description.
 *
 * The catalog is deliberately not a set of parameterless tool entries: those
 * render into the same native block and the grammar would accept a call to a
 * tool whose schema the model has never seen. Description text cannot be
 * called, which is the whole point.
 */
export function buildToolSearchTool(deferred: readonly Tool[]): Tool {
  return {
    type: 'function',
    name: TOOL_SEARCH_NAME,
    description:
      'Find tools by capability and load their full definitions into the conversation. ' +
      'The tools below are registered but their parameter schemas are not here yet — search ' +
      'for one by capability or by exact name, then call it on your next step.\n\n' +
      `Available tools:\n${buildCatalog(deferred)}`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A capability to search for, or the exact name of a tool to load.'
        },
        limit: {
          type: 'integer',
          description: `Maximum definitions to load (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`
        }
      },
      required: ['query']
    }
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
}

/**
 * Whether a query word matches a haystack word. A prefix so "repo" finds
 * "repository", but anchored at a word start: a bare substring test scores
 * "at" against "create_issue" and every query ends up matching everything.
 */
function matchesWord(words: readonly string[], token: string): boolean {
  return words.some((word) => word.startsWith(token))
}

function scoreTool(tool: Tool, query: string, tokens: readonly string[]): number {
  const name = tool.name.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()

  // Exact name wins outright: the model asking for a tool by name is not a
  // capability search and must not be outranked by a wordier description.
  if (name === normalizedQuery) return 1000

  let score = 0
  if (normalizedQuery.length > 2 && name.includes(normalizedQuery)) score += 100

  const nameWords = tokenize(tool.name)
  const descriptionWords = tokenize(tool.description)
  const groupWords = tokenize(tool.group ?? '')
  for (const token of tokens) {
    if (matchesWord(nameWords, token)) score += 50
    if (matchesWord(descriptionWords, token)) score += 10
    if (matchesWord(groupWords, token)) score += 5
  }
  return score
}

/**
 * Rank the deferred inventory against a query. Exact name first, then text
 * match. Ties keep registration order so repeated searches are deterministic.
 */
export function searchDeferredTools(
  deferred: readonly Tool[],
  query: string,
  limit?: number
): Tool[] {
  const tokens = tokenize(query)
  const scored = deferred
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, query, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const cap = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT)

  const picked: Tool[] = []
  let bytes = 0
  for (const { tool } of scored) {
    if (picked.length >= cap) break
    const size = JSON.stringify(toWireTool(tool)).length
    // Always let the top match through, however large; past that, stop rather
    // than truncate, so what the model receives is always a complete schema.
    if (picked.length > 0 && bytes + size > MAX_DEFINITION_BYTES) break
    picked.push(tool)
    bytes += size
  }
  return picked
}

export function buildToolSearchResult(
  query: string,
  matches: readonly Tool[],
  alreadyLoaded: readonly string[]
): string {
  const loaded = matches.map((tool) => tool.name)
  const result: ToolSearchResult = {
    tool_search: {
      query,
      loaded,
      already_loaded: [...alreadyLoaded],
      // Without this the model reads an empty result as "try again" and burns
      // rounds rephrasing the same query.
      ...(loaded.length === 0 && alreadyLoaded.length === 0 ? { hint: NO_MATCH_HINT } : {})
    },
    tools: matches.map(toWireTool)
  }
  return JSON.stringify(result)
}

function readSearchResult(content: string): ToolSearchResult['tool_search'] | null {
  if (!content.includes(`"${TOOL_SEARCH_NAME}"`)) return null
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null) return null
    const envelope = (parsed as Record<string, unknown>)[TOOL_SEARCH_NAME]
    if (typeof envelope !== 'object' || envelope === null) return null
    const loaded = (envelope as Record<string, unknown>)['loaded']
    if (!Array.isArray(loaded)) return null
    return {
      query: '',
      loaded: loaded.filter((name): name is string => typeof name === 'string'),
      already_loaded: []
    }
  } catch {
    // A tool result that isn't ours, or isn't JSON at all.
    return null
  }
}

/**
 * Which deferred definitions this conversation already carries.
 *
 * Read back from the history rather than held in the session, so `completion()`
 * stays stateless: a reopened chat replaying the same messages resolves the
 * same loaded set, and two concurrent conversations cannot see each other's.
 */
export function loadedToolNames(history: readonly HistoryMessage[]): Set<string> {
  const loaded = new Set<string>()
  for (const message of history) {
    if (message.role !== 'tool') continue
    const envelope = readSearchResult(message.content)
    if (!envelope) continue
    for (const name of envelope.loaded) loaded.add(name)
  }
  return loaded
}

export type DeferredResolution = {
  /** Definitions that go into the prompt: always-loaded tools plus `tool_search`. */
  toolsToRender: Tool[]
  /** Names the model may call now: rendered tools plus whatever history has loaded. */
  callableTools: Tool[]
  /** The full deferred inventory, for `tool_search` to search over. */
  deferred: Tool[]
}

/**
 * Split a registered tool list into what the prompt carries and what the
 * parser accepts.
 *
 * Loaded definitions stay out of `toolsToRender` on purpose. They live in the
 * history as tool results, which appends to the prefix instead of rewriting
 * the block at the front of it — a tool loaded mid-conversation must not cost
 * a re-prefill of everything before it.
 *
 * Returns `null` when nothing defers, so the existing path is untouched.
 */
export function resolveDeferredTools(
  tools: readonly Tool[] | undefined,
  history: readonly HistoryMessage[]
): DeferredResolution | null {
  if (!tools || tools.length === 0) return null
  const { alwaysLoaded, deferred } = partitionTools(tools)
  if (deferred.length === 0) return null

  const loaded = loadedToolNames(history)
  const rendered = [...alwaysLoaded.map(toWireTool), buildToolSearchTool(deferred)]
  return {
    toolsToRender: rendered,
    callableTools: [
      ...rendered,
      ...deferred.filter((tool) => loaded.has(tool.name)).map(toWireTool)
    ],
    deferred: [...deferred]
  }
}

/**
 * Run a `tool_search` call and produce the `tool` message that carries its
 * result. Pure over the history it is given; the caller appends the message.
 *
 * Takes either wire `Tool`s or the Zod-schema `ToolInput` form, because what a
 * caller holds is whatever they passed to `completion()`. A `ToolInput` whose
 * `parameters` is still a Zod object would otherwise be serialised as Zod
 * internals and reach the model as a definition it cannot call.
 */
export function executeToolSearch(
  tools: readonly Tool[] | readonly ToolInput[],
  args: Record<string, unknown>,
  history: readonly HistoryMessage[]
): string {
  const { tools: wire } = validateTools([...tools] as Tool[] | ToolInput[])
  const { deferred } = partitionTools(wire)
  const query = typeof args['query'] === 'string' ? args['query'] : ''
  const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined

  const loaded = loadedToolNames(history)
  const matches = searchDeferredTools(deferred, query, limit)

  // A definition already in the history is not appended a second time; naming
  // it back tells the model it can call the tool without searching again.
  const alreadyLoaded = matches.filter((tool) => loaded.has(tool.name)).map((tool) => tool.name)
  const fresh = matches.filter((tool) => !loaded.has(tool.name))

  return buildToolSearchResult(query, fresh, alreadyLoaded)
}
