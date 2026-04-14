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
  renderFunctionPage,
  renderIndexPage,
  renderErrorsPageContent,
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
  env.addGlobal('renderExpandedTypes', renderExpandedTypes)
  env.addGlobal('renderErrorTable', renderErrorTable)
  env.addGlobal('renderFunctionPage', renderFunctionPage)
  env.addGlobal('renderIndexPage', renderIndexPage)
  env.addGlobal('renderErrorsPage', renderErrorsPageContent)
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
// Template snapshot tests
// ---------------------------------------------------------------------------

describe('function-page template', () => {
  it('renders a full function with all sections', () => {
    const mdx = renderFunctionPage(fullFunction)
    const result = mdx.replace(/\bundefined\b/g, '\u2014').trim()
    expect(result).toMatchSnapshot()
  })

  it('renders a minimal function (no optional sections)', () => {
    const mdx = renderFunctionPage(minimalFunction)
    const result = mdx.replace(/\bundefined\b/g, '\u2014').trim()
    expect(result).toMatchSnapshot()
  })
})

describe('index-page template', () => {
  it('renders the index page', () => {
    const result = renderIndexPage([fullFunction, minimalFunction], 'v0.8.0')
    expect(result).toMatchSnapshot()
  })
})

describe('errors-page template', () => {
  it('renders the errors page with client and server errors', () => {
    const result = renderErrorsPageContent({ client: clientErrors, server: serverErrors })
    expect(result).toMatchSnapshot()
  })

  it('renders with only client errors', () => {
    const result = renderErrorsPageContent({ client: clientErrors, server: [] })
    expect(result).toMatchSnapshot()
  })

  it('returns null for empty errors', () => {
    expect(renderErrorsPageContent({ client: [], server: [] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Nunjucks template integration — verify templates call globals correctly
// ---------------------------------------------------------------------------

describe('Nunjucks template integration', () => {
  const env = createTestEnv()

  it('function-page.njk produces same output as renderFunctionPage', () => {
    const direct = renderFunctionPage(fullFunction)
    const viaTemplate = env.render('function-page.njk', { fn: fullFunction }).trim()
    expect(viaTemplate).toBe(direct)
  })

  it('index-page.njk produces same output as renderIndexPage', () => {
    const direct = renderIndexPage([fullFunction, minimalFunction], 'v0.8.0')
    const viaTemplate = env.render('index-page.njk', {
      functions: [fullFunction, minimalFunction],
      versionLabel: 'v0.8.0',
    }).trim()
    expect(viaTemplate).toBe(direct.trim())
  })

  it('errors-page.njk produces same output as renderErrorsPageContent', () => {
    const direct = renderErrorsPageContent({ client: clientErrors, server: serverErrors })
    const viaTemplate = env.render('errors-page.njk', {
      errors: { client: clientErrors, server: serverErrors },
    }).trim()
    expect(viaTemplate).toBe(direct!.trim())
  })
})

// ---------------------------------------------------------------------------
// Parity checks — verify output matches original monolith TS functions
// ---------------------------------------------------------------------------

describe('output parity with original monolith', () => {
  /**
   * Reimplementation of the original generateMDXForFunction from the monolith.
   * Used as the ground-truth baseline for parity verification.
   */
  function originalGenerateMDX(fn: ApiFunction): string {
    function origRenderExpandedTypes(types: ExpandedType[], baseDepth: number): string {
      const sections: string[] = []
      for (const expanded of types) {
        const heading = '#'.repeat(Math.min(baseDepth, 5))
        sections.push(`${heading} \`${expanded.typeName}\`

| Field | Type | Required? | Description |
| --- | --- | :---: | --- |
${expanded.fields
  .map((f) => {
    const typeStr = f.type.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\|/g, '\\|')
    return `| \`${f.name}\` | \`${typeStr}\` | ${f.required ? '\u2713' : '\u2717'} | ${(f.description || '\u2014').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\|/g, '\\|')} |`
  })
  .join('\n')}`)
        if (expanded.children.length > 0) {
          sections.push(origRenderExpandedTypes(expanded.children, baseDepth + 1))
        }
      }
      return sections.join('\n\n')
    }

    const expandedParamsSection = fn.expandedParams.length > 0
      ? '\n\n' + origRenderExpandedTypes(fn.expandedParams, 3)
      : ''

    const parametersTable =
      fn.parameters.length > 0
        ? `## Parameters

| Name | Type | Required? | Description |
| --- | --- | :---: | --- |
${fn.parameters
  .map((p) => {
    const typeStr = p.type.replace(/\{/g, '\\{').replace(/\}/g, '\\}')
    const anchor = p.type.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const hasExpansion = fn.expandedParams.some(
      (e) => e.typeName.toLowerCase() === p.type.toLowerCase(),
    )
    const typeCell = hasExpansion ? `[\`${typeStr}\`](#${anchor})` : `\`${typeStr}\``
    return `| \`${p.name}\` | ${typeCell} | ${p.required ? '\u2713' : '\u2717'} | ${(p.description || 'No description').replace(/\{/g, '\\{').replace(/\}/g, '\\}')} |`
  })
  .join('\n')}${expandedParamsSection}`
        : ''

    const examplesSection = fn.examples?.length
      ? `## Example

${fn.examples
  .map((ex) => {
    const stripped = ex.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')
    return `\`\`\`typescript\n${stripped}\n\`\`\``
  })
  .join('\n\n')}`
      : ''

    const desc = String(fn.description ?? 'No description available').replace(/"/g, '\\"').replace(/\bundefined\b/g, '\u2014')
    const returnsDesc = String(fn.returns?.description ?? 'No description available').replace(/\bundefined\b/g, '\u2014')

    const deprecationCallout = fn.deprecated
      ? `<Callout type="warn" title="Deprecated">\n${fn.deprecated}\n</Callout>\n\n`
      : ''

    const throwsSection = fn.throws?.length
      ? `## Throws

| Error | When |
| --- | --- |
${fn.throws.map((t) => `| \`${t.error}\` | ${t.description} |`).join('\n')}`
      : ''

    const returnFieldsTable = fn.returnFields.length > 0
      ? `\n\n| Field | Type | Description |
| --- | --- | --- |
${fn.returnFields
  .map((f) => {
    const typeStr = f.type.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\|/g, '\\|')
    return `| \`${f.name}\` | \`${typeStr}\` | ${(f.description || '\u2014').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\|/g, '\\|')} |`
  })
  .join('\n')}`
      : ''

    const expandedReturnsSection = fn.expandedReturns.length > 0
      ? '\n\n' + origRenderExpandedTypes(fn.expandedReturns, 3)
      : ''

    return `---
title: "${fn.name}( )"
titleStyle: code
description: "${desc}"
---

${deprecationCallout}\`\`\`typescript
${fn.signature}
\`\`\`

${parametersTable}

## Returns

\`\`\`typescript
${fn.returns?.type ?? 'unknown'}
\`\`\`

${returnsDesc}${returnFieldsTable}${expandedReturnsSection}

${throwsSection}

${examplesSection}
`.trim()
  }

  function originalGenerateIndexMDX(functions: ApiFunction[], versionLabel: string): string {
    const fSentence = (text: string) => {
      const match = text.match(/^[^.!?]+[.!?]/)
      return match ? match[0] : text
    }
    const fmtSig = (fn: ApiFunction) => {
      const sig = fn.signature.replace(/^function\s+/, '')
      return sig.replace(/\|/g, '\\|')
    }

    return `---
title: "@qvac/sdk"
titleStyle: code
description: API reference \u2014 ${versionLabel}
---

## Overview

\`@qvac/sdk\` npm package exposes a function-centric, typed JS API.

## Functions

| Function | Summary | Signature |
| --- | --- | --- |
${functions
  .map((fn) => {
    const summary = fSentence(fn.description).replace(/\|/g, '\\|')
    const sig = fmtSig(fn)
    return `| [\`${fn.name}()\`](./${fn.name}) | ${summary} | \`${sig}\` |`
  })
  .join('\n')}

## Errors

See [Errors](./errors) for the full list of SDK error codes.
`
  }

  function originalWriteErrorsContent(
    errors: { client: ErrorEntry[]; server: ErrorEntry[] },
  ): string {
    function renderTable(entries: ErrorEntry[]): string {
      return `| Error | Code | Summary |
| --- | --- | --- |
${entries.map((e) => `| \`${e.name}\` | ${e.code} | ${e.summary.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[{}]/g, '\\$&')} |`).join('\n')}`
    }

    const sections: string[] = []
    sections.push(`---
title: Errors
description: SDK error codes reference
---

## Example

\`\`\`typescript
import { SDK_CLIENT_ERROR_CODES, SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await loadModel({ modelSrc: "/path/to/model.gguf", modelType: "llm" });
} catch (error) {
  if (error.code === SDK_SERVER_ERROR_CODES.MODEL_LOAD_FAILED) {
    // handle model load failure
  }
}
\`\`\``)

    if (errors.client.length > 0) {
      sections.push(`## Client errors

Thrown on the client side (response validation, RPC, provider). Access via \`SDK_CLIENT_ERROR_CODES.{ERROR_NAME}\`.

${renderTable(errors.client)}`)
    }

    if (errors.server.length > 0) {
      sections.push(`## Server errors

Thrown by the server (model operations, downloads, cache, RAG). Access via \`SDK_SERVER_ERROR_CODES.{ERROR_NAME}\`.

${renderTable(errors.server)}`)
    }

    return sections.join('\n\n') + '\n'
  }

  it('function page — full function matches original', () => {
    const rawExpected = originalGenerateMDX(fullFunction)
    const expected = rawExpected.replace(/\bundefined\b/g, '\u2014').trim()
    const actual = renderFunctionPage(fullFunction).replace(/\bundefined\b/g, '\u2014').trim()
    expect(actual).toBe(expected)
  })

  it('function page — minimal function matches original', () => {
    const rawExpected = originalGenerateMDX(minimalFunction)
    const expected = rawExpected.replace(/\bundefined\b/g, '\u2014').trim()
    const actual = renderFunctionPage(minimalFunction).replace(/\bundefined\b/g, '\u2014').trim()
    expect(actual).toBe(expected)
  })

  it('index page matches original', () => {
    const expected = originalGenerateIndexMDX([fullFunction, minimalFunction], 'v0.8.0')
    const actual = renderIndexPage([fullFunction, minimalFunction], 'v0.8.0')
    expect(actual).toBe(expected)
  })

  it('errors page matches original', () => {
    const expected = originalWriteErrorsContent({ client: clientErrors, server: serverErrors })
    const actual = renderErrorsPageContent({ client: clientErrors, server: serverErrors })
    expect(actual).toBe(expected)
  })
})
