// Deferred tool loading (deferLoading + tool_search) test definitions
import type { TestDefinition } from '@qvac/test-suite'
import type { ToolDialect } from '@qvac/sdk'

export interface DeferredToolDef {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  deferLoading?: boolean
  group?: string
}

function deferred(group: string, tool: Omit<DeferredToolDef, 'type'>): DeferredToolDef {
  return { type: 'function', ...tool, deferLoading: true, group }
}

const EAGER_TOOL: DeferredToolDef = {
  type: 'function',
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city']
  }
}

// Schemas are deliberately verbose so their absence from the prompt shows up
// as a large prompt-token difference.
const DEFERRED_TOOLS: DeferredToolDef[] = [
  deferred('astrology', {
    name: 'get_horoscope',
    description: "Get today's horoscope for an astrological sign",
    parameters: {
      type: 'object',
      properties: {
        sign: {
          type: 'string',
          enum: [
            'aries',
            'taurus',
            'gemini',
            'cancer',
            'leo',
            'virgo',
            'libra',
            'scorpio',
            'sagittarius',
            'capricorn',
            'aquarius',
            'pisces'
          ],
          description: 'Astrological sign, lowercase'
        },
        day: {
          type: 'string',
          enum: ['yesterday', 'today', 'tomorrow'],
          description: 'Which day to read the horoscope for'
        }
      },
      required: ['sign']
    }
  }),
  deferred('astrology', {
    name: 'get_moon_phase',
    description: 'Get the phase of the moon on a given date',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO 8601 date, for example 2026-09-28' },
        timezone: { type: 'string', description: 'IANA timezone name, for example Europe/Madrid' }
      },
      required: ['date']
    }
  }),
  deferred('finance', {
    name: 'get_stock_price',
    description: 'Get the latest trading price for a stock ticker',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol, for example AAPL' },
        exchange: {
          type: 'string',
          enum: ['NASDAQ', 'NYSE', 'LSE', 'TSE'],
          description: 'Exchange the ticker is listed on'
        },
        currency: { type: 'string', description: 'ISO 4217 currency to report the price in' }
      },
      required: ['ticker']
    }
  }),
  deferred('finance', {
    name: 'convert_currency',
    description: 'Convert an amount of money from one currency to another',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to convert' },
        from: { type: 'string', description: 'ISO 4217 source currency code' },
        to: { type: 'string', description: 'ISO 4217 target currency code' }
      },
      required: ['amount', 'from', 'to']
    }
  }),
  deferred('github', {
    name: 'create_issue',
    description: 'Open a new issue on a GitHub repository',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body in Markdown' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub usernames to assign'
        }
      },
      required: ['repo', 'title']
    }
  }),
  deferred('github', {
    name: 'list_pull_requests',
    description: 'List pull requests on a GitHub repository',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form' },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by pull request state'
        },
        author: { type: 'string', description: 'Only pull requests opened by this user' },
        limit: { type: 'integer', description: 'Maximum number of results' }
      },
      required: ['repo']
    }
  }),
  deferred('github', {
    name: 'merge_pull_request',
    description: 'Merge an open pull request',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name form' },
        number: { type: 'integer', description: 'Pull request number' },
        method: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: 'Merge strategy'
        }
      },
      required: ['repo', 'number']
    }
  }),
  deferred('calendar', {
    name: 'create_event',
    description: 'Create a calendar event',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time as an ISO 8601 timestamp' },
        end: { type: 'string', description: 'End time as an ISO 8601 timestamp' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses of the attendees'
        },
        location: { type: 'string', description: 'Where the event takes place' }
      },
      required: ['title', 'start']
    }
  }),
  deferred('calendar', {
    name: 'list_events',
    description: 'List calendar events in a time range',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Range start as an ISO 8601 timestamp' },
        to: { type: 'string', description: 'Range end as an ISO 8601 timestamp' },
        calendar: { type: 'string', description: 'Calendar name, defaults to the primary one' }
      },
      required: ['from', 'to']
    }
  })
]

export const DEFERRED_TOOL_INVENTORY: DeferredToolDef[] = [EAGER_TOOL, ...DEFERRED_TOOLS]

const SYSTEM_PROMPT =
  'You are a helpful assistant. Tools listed in the tool_search catalog must be ' +
  'searched for before you can call them.'

export interface DeferredToolsParams {
  systemPrompt: string
  userPrompt: string
  // Query of the tool_search call placed in the history.
  searchQuery?: string
  expectedToolCall: { name: string; argKeys?: string[] }
  resourceKey?: string
  toolDialect?: ToolDialect
}

/**
 * No declarative body: the history is built by the client-side `executeToolSearch` helper, which no
 * contract method exposes, in each dialect's own tool-call syntax.
 */
function createDeferredToolsTest(
  testId: string,
  params: Omit<DeferredToolsParams, 'systemPrompt'>,
  options: { suites?: string[]; estimatedDurationMs?: number } = {}
): TestDefinition {
  return {
    testId,
    params: { systemPrompt: SYSTEM_PROMPT, ...params },
    expectation: { validation: 'type', expectedType: 'string' },
    ...(options.suites && { suites: options.suites }),
    metadata: {
      category: 'tools',
      dependency: params.resourceKey ?? 'tools',
      estimatedDurationMs: options.estimatedDurationMs ?? 30000
    }
  }
}

const HOROSCOPE = {
  userPrompt: "What's my horoscope for Aquarius today?",
  searchQuery: 'horoscope',
  expectedToolCall: { name: 'get_horoscope', argKeys: ['sign'] }
}

// Deferred schemas stay out of the prompt: swapping every deferred schema for
// an empty one leaves the prompt-token count unchanged, while loading the same
// inventory eagerly costs more.
export const deferredToolsPromptCost = createDeferredToolsTest(
  'deferred-tools-prompt-cost',
  HOROSCOPE,
  { suites: ['smoke'] }
)

// A search result in the history makes the tool natively callable on the next step.
export const deferredToolsLoadThenCall = createDeferredToolsTest(
  'deferred-tools-load-then-call',
  HOROSCOPE,
  { suites: ['smoke'] }
)

// The model issues tool_search itself, then calls the tool it loaded.
export const deferredToolsSearchThenCall = createDeferredToolsTest(
  'deferred-tools-search-then-call',
  {
    userPrompt:
      'Search for a tool that reads horoscopes, then use it to get the horoscope for Aquarius.',
    expectedToolCall: HOROSCOPE.expectedToolCall
  },
  { estimatedDurationMs: 60000 }
)

// Searching for an already-loaded tool appends no second definition.
export const deferredToolsRepeatSearch = createDeferredToolsTest(
  'deferred-tools-repeat-search',
  HOROSCOPE
)

// The same persisted history still carries the loaded tool after a model reload.
export const deferredToolsReopenedChat = createDeferredToolsTest(
  'deferred-tools-reopened-chat',
  HOROSCOPE,
  { estimatedDurationMs: 90000 }
)

// Two chats on one model with different kvCache keys ask the same question: a
// tool loaded in one is not callable from the other.
export const deferredToolsKvCacheIsolation = createDeferredToolsTest(
  'deferred-tools-kv-cache-isolation',
  HOROSCOPE,
  { estimatedDurationMs: 60000 }
)

export const deferredToolsLoadThenCallQwen35 = createDeferredToolsTest(
  'deferred-tools-load-then-call-qwen35',
  { ...HOROSCOPE, resourceKey: 'tools-qwen35', toolDialect: 'qwen35' }
)

export const deferredToolsTests = [
  deferredToolsPromptCost,
  deferredToolsLoadThenCall,
  deferredToolsSearchThenCall,
  deferredToolsRepeatSearch,
  deferredToolsReopenedChat,
  deferredToolsKvCacheIsolation,
  deferredToolsLoadThenCallQwen35
]
