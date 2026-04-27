import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import nunjucks from 'nunjucks'
import type { ApiData, ApiFunction, ApiObject } from '../scripts/api-docs/types'
import {
  escapeTableLight,
  firstSentence,
  stripFence,
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
  env.addFilter('escapeTableLight', escapeTableLight)
  env.addFilter('firstSentence', firstSentence)
  env.addFilter('stripFence', stripFence)
  return env
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const completionFn: ApiFunction = {
  name: 'completion',
  signature: 'declare function completion(params: CompletionParams): CompletionRun;',
  description: 'Generates completion from a language model based on conversation history.',
  parameters: [],
  expandedParams: [],
  returns: { type: 'CompletionRun', description: '' },
  returnFields: [],
  expandedReturns: [],
  throws: [
    { error: 'INVALID_TOOLS_ARRAY', description: 'Invalid tools array provided' },
    { error: 'INVALID_TOOL_SCHEMA', description: 'A tool has an invalid schema' },
  ],
  examples: [
    'const run = completion({ modelId: "llama-2", history: [] });',
  ],
}

const minimalFn: ApiFunction = {
  name: 'suspend',
  signature: 'declare function suspend(): Promise<void>;',
  description: 'Suspends all active Hyperswarm and Corestore resources.',
  parameters: [],
  expandedParams: [],
  returns: { type: 'Promise<void>', description: '' },
  returnFields: [],
  expandedReturns: [],
}

const overloadedFn: ApiFunction = {
  name: 'embed',
  signature:
    'declare function embed(params: { modelId: string; text: string }): Promise<{ embedding: number[] }>;\n' +
    'declare function embed(params: { modelId: string; text: string[] }): Promise<{ embedding: number[][] }>;',
  description: '',
  parameters: [],
  expandedParams: [],
  returns: { type: 'Promise<{ embedding: number[] }>', description: '' },
  returnFields: [],
  expandedReturns: [],
  overloads: [
    {
      signature:
        'declare function embed(params: { modelId: string; text: string }): Promise<{ embedding: number[] }>;',
    },
    {
      signature:
        'declare function embed(params: { modelId: string; text: string[] }): Promise<{ embedding: number[][] }>;',
    },
  ],
}

const profilerObject: ApiObject = {
  name: 'profiler',
  description: 'Singleton object that collects and exports profiling data for SDK operations.',
  objectSignature:
    'const profiler: {\n  enable(options?: ProfilerRuntimeOptions): void;\n  disable(): void;\n};',
  fields: [],
  children: [],
  methods: [
    {
      name: 'enable',
      signature: 'function enable(options?: ProfilerRuntimeOptions): void',
      description: 'Enables profiling and resets all previously aggregated data.',
      summary: 'Enables profiling and resets aggregated data.',
      parameters: [
        { name: 'options', type: 'ProfilerRuntimeOptions', required: false, description: '' },
      ],
      expandedParams: [],
      returns: { type: 'void', description: '' },
      returnFields: [],
      expandedReturns: [],
    },
    {
      name: 'disable',
      signature: 'function disable(): void',
      description: 'Disables profiling.',
      summary: 'Disables profiling. New SDK operations will no longer be recorded.',
      parameters: [],
      expandedParams: [],
      returns: { type: 'void', description: '' },
      returnFields: [],
      expandedReturns: [],
    },
  ],
  examples: ['profiler.enable({ mode: "summary" });'],
}

const apiData: ApiData = {
  version: '0.9.1',
  generatedAt: 'unspecified',
  functions: [completionFn, minimalFn, overloadedFn],
  objects: [profilerObject],
  errors: {
    client: [
      { name: 'INVALID_RESPONSE_TYPE', code: 50001, summary: 'Invalid response type received.' },
      { name: 'RPC_CONNECTION_FAILED', code: 50203, summary: 'RPC connection failed.' },
    ],
    server: [
      { name: 'MODEL_NOT_FOUND', code: 52002, summary: 'Model ID not found in the registry.' },
    ],
  },
}

const renderArgs = {
  functions: apiData.functions,
  objects: apiData.objects ?? [],
  errors: apiData.errors,
  versionLabel: 'v0.9.1',
  scopeSummary: '3 functions in `packages/sdk/client/api/` plus the `profiler` object',
}

// ---------------------------------------------------------------------------
// Filter unit tests
// ---------------------------------------------------------------------------

describe('firstSentence', () => {
  it('extracts first sentence ending with period', () => {
    expect(firstSentence('Hello world. More text here.')).toBe('Hello world.')
  })
  it('returns full text when no sentence boundary', () => {
    expect(firstSentence('no sentence here')).toBe('no sentence here')
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
// single-page.njk rendering
// ---------------------------------------------------------------------------

describe('single-page template', () => {
  const env = createTestEnv()

  it('renders a complete API summary page', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toMatchSnapshot()
  })

  it('emits valid frontmatter with the version label', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toMatch(/^---\ntitle: API Summary — v0\.9\.1\n/)
    expect(mdx).toContain('description: One-page reference of all public functions and objects exported by @qvac/sdk')
  })

  it('emits the autogen / scope callout', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toContain('Auto-generated from `.d.ts` declarations and TSDoc comments.')
    expect(mdx).toContain('**Scope**: 3 functions in `packages/sdk/client/api/` plus the `profiler` object.')
  })

  it('renders one ### heading per function', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toContain('### `completion`')
    expect(mdx).toContain('### `suspend`')
    expect(mdx).toContain('### `embed`')
  })

  it('renders signature, throws and example blocks for the simple-overload case', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toContain('**Signature**:')
    expect(mdx).toContain('declare function completion(params: CompletionParams): CompletionRun;')
    expect(mdx).toContain('**Throws**:')
    expect(mdx).toContain('- `INVALID_TOOLS_ARRAY` — Invalid tools array provided')
    expect(mdx).toContain('**Example**:')
  })

  it('renders #### Overload N subsections for multi-signature functions', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toContain('Has 2 overloads.')
    expect(mdx).toContain('#### Overload 1')
    expect(mdx).toContain('#### Overload 2')
    expect(mdx).toContain('declare function embed(params: { modelId: string; text: string }): Promise<{ embedding: number[] }>;')
    expect(mdx).toContain('declare function embed(params: { modelId: string; text: string[] }): Promise<{ embedding: number[][] }>;')
  })

  it('renders the profiler object section with shape and methods', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toContain('## Objects')
    expect(mdx).toContain('### `profiler`')
    expect(mdx).toContain('**Shape**:')
    expect(mdx).toContain('**Methods**:')
    expect(mdx).toMatch(/-\s+\*\*`enable\(options\?\)`\*\*\s+—\s+Enables profiling and resets aggregated data/)
    expect(mdx).toContain('**Example**:')
  })

  it('renders the folded errors section with both client and server tables', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).toContain('## Errors')
    expect(mdx).toContain('### Client errors')
    expect(mdx).toContain('### Server errors')
    expect(mdx).toContain('| `INVALID_RESPONSE_TYPE` | 50001 | Invalid response type received. |')
    expect(mdx).toContain('| `MODEL_NOT_FOUND` | 52002 | Model ID not found in the registry. |')
  })

  it('does not render parameter or return-field tables (those live in .d.ts)', () => {
    const mdx = env.render('single-page.njk', renderArgs).trim()
    expect(mdx).not.toMatch(/^\| Name \| Type \| Required\? \| Description \|$/m)
    expect(mdx).not.toMatch(/^\| Field \| Type \| Required\? \| Description \|$/m)
  })

  it('skips the Errors section when the error tables are empty', () => {
    const mdx = env
      .render('single-page.njk', {
        ...renderArgs,
        errors: { client: [], server: [] },
      })
      .trim()
    expect(mdx).toContain('## Errors')
    expect(mdx).not.toContain('### Client errors')
    expect(mdx).not.toContain('### Server errors')
  })

  it('skips the Objects section when no objects are exported', () => {
    const mdx = env
      .render('single-page.njk', {
        ...renderArgs,
        objects: [],
      })
      .trim()
    expect(mdx).not.toContain('## Objects')
  })

  it('renders a deprecation callout for deprecated functions', () => {
    const deprecatedFn: ApiFunction = {
      ...minimalFn,
      name: 'oldThing',
      deprecated: 'Use newThing() instead.',
    }
    const mdx = env
      .render('single-page.njk', {
        ...renderArgs,
        functions: [deprecatedFn],
      })
      .trim()
    expect(mdx).toContain('### `oldThing`')
    expect(mdx).toContain('> ⚠️ **Deprecated**: Use newThing() instead.')
  })
})
