import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import nunjucks from 'nunjucks'
import type { ApiFunction, ExpandedType, ErrorEntry } from '../scripts/api-docs/types'
import {
  escapeTable,
  escapeTableLight,
  firstSentence,
  slugify,
  formatShortSignature,
  escapeQuotes,
  stripFence,
  renderExpandedTypes,
  renderErrorTable,
} from '../scripts/api-docs/render'

const SCRIPT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'api-docs',
)
const TEMPLATE_DIR = path.join(SCRIPT_DIR, 'templates')

function createTestEnv(): nunjucks.Environment {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(TEMPLATE_DIR),
    { autoescape: false, trimBlocks: true, lstripBlocks: true },
  )
  env.addFilter('escapeTable', escapeTable)
  env.addFilter('escapeTableLight', escapeTableLight)
  env.addFilter('firstSentence', firstSentence)
  env.addFilter('slugify', slugify)
  env.addFilter('formatShortSignature', formatShortSignature)
  env.addFilter('escapeQuotes', escapeQuotes)
  env.addFilter('stripFence', stripFence)
  env.addFilter('lower', (s: string) => s.toLowerCase())
  env.addFilter('replace', (s: string, from: string, to: string) =>
    s.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to),
  )
  env.addGlobal('renderExpandedTypes', renderExpandedTypes)
  env.addGlobal('renderErrorTable', renderErrorTable)
  return env
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullFunction: ApiFunction = {
  name: 'completion',
  signature: 'function completion(params: CompletionParams): CompletionResult',
  description: 'Generates completion from a language model. Returns streamed tokens.',
  parameters: [
    { name: 'params', type: 'CompletionParams', required: true, description: 'The completion parameters' },
  ],
  expandedParams: [
    {
      typeName: 'CompletionParams',
      fields: [
        { name: 'modelId', type: 'string', required: true, description: 'The model identifier' },
        { name: 'history', type: 'HistoryMessage[]', required: true, description: 'Array of messages' },
        { name: 'stream', type: 'boolean', required: false, description: 'Whether to stream tokens' },
      ],
      children: [
        {
          typeName: 'HistoryMessage',
          fields: [
            { name: 'role', type: 'string', required: true, description: 'Message role' },
            { name: 'content', type: 'string', required: true, description: 'Message content' },
          ],
          children: [],
        },
      ],
    },
  ],
  returns: { type: 'CompletionResult', description: 'The completion result object.' },
  returnFields: [
    { name: 'text', type: 'Promise<string>', required: true, description: 'Complete generated text' },
    { name: 'stats', type: 'CompletionStats | undefined', required: false, description: 'Performance statistics' },
  ],
  expandedReturns: [
    {
      typeName: 'CompletionStats',
      fields: [
        { name: 'tokensPerSecond', type: 'number', required: true, description: 'Tokens per second' },
      ],
      children: [],
    },
  ],
  throws: [
    { error: 'INVALID_TOOLS_ARRAY', description: 'Invalid tools array provided' },
    { error: 'COMPLETION_FAILED', description: 'Completion failed' },
  ],
  examples: [
    '```typescript\nconst result = completion({ modelId: "llama-2", history: [{ role: "user", content: "Hello" }] });\n```',
  ],
  deprecated: 'Use completionV2() instead.',
}

const minimalFunction: ApiFunction = {
  name: 'ping',
  signature: 'function ping(): Promise<{ type: "pong"; number: number }>',
  description: 'Sends a ping request to the server.',
  parameters: [],
  expandedParams: [],
  returns: { type: 'Promise<{ type: "pong"; number: number }>', description: 'The pong response.' },
  returnFields: [],
  expandedReturns: [],
}

const clientErrors: ErrorEntry[] = [
  { name: 'INVALID_RESPONSE_TYPE', code: 50001, summary: 'Invalid response type received.' },
  { name: 'RPC_CONNECTION_FAILED', code: 50203, summary: 'RPC connection failed.' },
]

const serverErrors: ErrorEntry[] = [
  { name: 'MODEL_NOT_FOUND', code: 52002, summary: 'Model ID not found in the registry.' },
  { name: 'DOWNLOAD_CANCELLED', code: 53001, summary: 'Download cancelled.' },
]

// ---------------------------------------------------------------------------
// Filter unit tests
// ---------------------------------------------------------------------------

describe('escapeTable', () => {
  it('escapes backslashes, pipes, and braces', () => {
    expect(escapeTable('a\\b|c{d}e')).toBe('a\\\\b\\|c\\{d\\}e')
  })
})

describe('escapeTableLight', () => {
  it('escapes pipes and braces but not backslashes', () => {
    expect(escapeTableLight('a\\b|c{d}e')).toBe('a\\b\\|c\\{d\\}e')
  })
})

describe('firstSentence', () => {
  it('extracts first sentence ending with period', () => {
    expect(firstSentence('Hello world. More text here.')).toBe('Hello world.')
  })

  it('returns full text when no sentence boundary', () => {
    expect(firstSentence('no sentence here')).toBe('no sentence here')
  })

  it('handles exclamation marks', () => {
    expect(firstSentence('Done! More.')).toBe('Done!')
  })
})

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with dashes', () => {
    expect(slugify('CompletionParams')).toBe('completionparams')
    expect(slugify('Promise<string>')).toBe('promise-string-')
  })
})

describe('formatShortSignature', () => {
  it('strips function keyword and escapes pipes', () => {
    expect(formatShortSignature('function foo(a: string | number): void'))
      .toBe('foo(a: string \\| number): void')
  })
})

describe('escapeQuotes', () => {
  it('escapes double quotes', () => {
    expect(escapeQuotes('say "hello"')).toBe('say \\"hello\\"')
  })
})

describe('stripFence', () => {
  it('strips opening and closing fences', () => {
    expect(stripFence('```typescript\nconst x = 1;\n```')).toBe('const x = 1;')
  })

  it('handles fences without language', () => {
    expect(stripFence('```\ncode\n```')).toBe('code')
  })
})

// ---------------------------------------------------------------------------
// renderExpandedTypes
// ---------------------------------------------------------------------------

describe('renderExpandedTypes', () => {
  it('renders a flat expanded type', () => {
    const types: ExpandedType[] = [
      {
        typeName: 'Options',
        fields: [
          { name: 'timeout', type: 'number', required: true, description: 'Timeout in ms' },
          { name: 'retries', type: 'number', required: false, description: '' },
        ],
        children: [],
      },
    ]
    expect(renderExpandedTypes(types, 3)).toMatchSnapshot()
  })

  it('renders nested expanded types', () => {
    const types: ExpandedType[] = [
      {
        typeName: 'Outer',
        fields: [{ name: 'inner', type: 'Inner', required: true, description: 'Nested' }],
        children: [
          {
            typeName: 'Inner',
            fields: [{ name: 'value', type: 'string', required: true, description: 'The value' }],
            children: [],
          },
        ],
      },
    ]
    expect(renderExpandedTypes(types, 3)).toMatchSnapshot()
  })

  it('caps heading depth at 5', () => {
    const result = renderExpandedTypes(
      [{ typeName: 'Deep', fields: [{ name: 'a', type: 'string', required: true, description: 'desc' }], children: [] }],
      6,
    )
    expect(result).toContain('##### `Deep`')
  })
})

// ---------------------------------------------------------------------------
// Template rendering tests — verify Nunjucks templates produce valid output
// ---------------------------------------------------------------------------

describe('function-page template', () => {
  const env = createTestEnv()

  it('renders a full function with all sections', () => {
    const mdx = env.render('function-page.njk', { fn: fullFunction }).trim()
    const result = mdx.replace(/\bundefined\b/g, '\u2014')
    expect(result).toMatchSnapshot()
  })

  it('renders a minimal function (no optional sections)', () => {
    const mdx = env.render('function-page.njk', { fn: minimalFunction }).trim()
    const result = mdx.replace(/\bundefined\b/g, '\u2014')
    expect(result).toMatchSnapshot()
  })

  it('includes frontmatter', () => {
    const mdx = env.render('function-page.njk', { fn: fullFunction }).trim()
    expect(mdx).toMatch(/^---\ntitle:/)
  })

  it('includes deprecation callout when deprecated', () => {
    const mdx = env.render('function-page.njk', { fn: fullFunction }).trim()
    expect(mdx).toContain('<Callout type="warn" title="Deprecated">')
    expect(mdx).toContain('Use completionV2() instead.')
  })

  it('omits deprecation callout when not deprecated', () => {
    const mdx = env.render('function-page.njk', { fn: minimalFunction }).trim()
    expect(mdx).not.toContain('Deprecated')
  })

  it('renders parameters table with expanded type links', () => {
    const mdx = env.render('function-page.njk', { fn: fullFunction }).trim()
    expect(mdx).toContain('[`CompletionParams`](#completionparams)')
  })

  it('renders throws section', () => {
    const mdx = env.render('function-page.njk', { fn: fullFunction }).trim()
    expect(mdx).toContain('## Throws')
    expect(mdx).toContain('`INVALID_TOOLS_ARRAY`')
  })

  it('shows AI provenance callout for AI-generated descriptions', () => {
    const aiFunction = { ...minimalFunction, descriptionSource: 'ai' as const }
    const mdx = env.render('function-page.njk', { fn: aiFunction }).trim()
    expect(mdx).toContain('AI-generated description')
  })

  it('shows AI provenance callout for AI-generated examples', () => {
    const aiFunction = {
      ...minimalFunction,
      examples: ['```typescript\nconst x = 1;\n```'],
      examplesSource: 'ai' as const,
    }
    const mdx = env.render('function-page.njk', { fn: aiFunction }).trim()
    expect(mdx).toContain('AI-generated example')
  })
})

describe('index-page template', () => {
  const env = createTestEnv()

  it('renders the index page', () => {
    const result = env.render('index-page.njk', {
      functions: [fullFunction, minimalFunction],
      versionLabel: 'v0.8.0',
    }).trim()
    expect(result).toMatchSnapshot()
  })

  it('includes function table rows', () => {
    const result = env.render('index-page.njk', {
      functions: [fullFunction, minimalFunction],
      versionLabel: 'v0.8.0',
    }).trim()
    expect(result).toContain('[`completion()`](./completion)')
    expect(result).toContain('[`ping()`](./ping)')
  })
})

describe('errors-page template', () => {
  const env = createTestEnv()

  it('renders the errors page with client and server errors', () => {
    const result = env.render('errors-page.njk', {
      errors: { client: clientErrors, server: serverErrors },
    }).trim()
    expect(result).toMatchSnapshot()
  })

  it('renders with only client errors', () => {
    const result = env.render('errors-page.njk', {
      errors: { client: clientErrors, server: [] },
    }).trim()
    expect(result).toContain('## Client errors')
    expect(result).not.toContain('## Server errors')
  })

  it('renders with only server errors', () => {
    const result = env.render('errors-page.njk', {
      errors: { client: [], server: serverErrors },
    }).trim()
    expect(result).not.toContain('## Client errors')
    expect(result).toContain('## Server errors')
  })
})

// ---------------------------------------------------------------------------
// Object and shared-types templates
// ---------------------------------------------------------------------------

describe('object-page template', () => {
  const env = createTestEnv()

  it('renders an object page with fields', () => {
    const obj = {
      name: 'CompletionParams',
      description: 'Parameters for the completion function.',
      fields: [
        { name: 'modelId', type: 'string', required: true, description: 'The model identifier' },
        { name: 'stream', type: 'boolean', required: false, description: 'Whether to stream' },
      ],
      children: [],
    }
    const mdx = env.render('object-page.njk', { obj }).trim()
    expect(mdx).toContain('title: "CompletionParams"')
    expect(mdx).toContain('## Fields')
    expect(mdx).toContain('`modelId`')
    expect(mdx).toMatchSnapshot()
  })
})

describe('shared-types template', () => {
  const env = createTestEnv()

  it('renders a shared types page', () => {
    const types = [
      {
        name: 'ModelType',
        description: 'Supported model types.',
        definition: 'type ModelType = "llm" | "embed" | "tts"',
        members: [
          { name: 'llm', description: 'Large language model' },
          { name: 'embed', description: 'Embedding model' },
        ],
      },
      {
        name: 'CachePolicy',
        description: 'Cache eviction policies.',
        definition: 'type CachePolicy = "lru" | "fifo"',
      },
    ]
    const mdx = env.render('shared-types.njk', { types, versionLabel: 'v0.8.0' }).trim()
    expect(mdx).toContain('### `ModelType`')
    expect(mdx).toContain('### `CachePolicy`')
    expect(mdx).toContain('| `llm`')
    expect(mdx).toMatchSnapshot()
  })
})
