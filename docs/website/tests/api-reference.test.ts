import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { functionCard, modelsForEngines, shapeAsTypeScript } from '../src/lib/api-reference/card'
import { contractTargetOf } from '../src/lib/api-reference/client-map'
import { functionReference, lineOfUrl, loadLineApi, type LineApi } from '../src/lib/api-reference/data'
import { toSnakeCase } from '../src/lib/api-reference/names'
import { SchemaReader } from '../src/lib/api-reference/schema'
import { parityGaps } from '../scripts/api-reference/check-sdk-parity'
import { inline } from '../scripts/write-schema-slices'

const MONOREPO = path.resolve(import.meta.dirname, '..', '..', '..')
const SDK_PATHS = ['packages/sdk/docs/users', 'packages/sdk/contract']

describe('Python names', () => {
  it('turn camelCase into snake_case', () => {
    expect(toSnakeCase('modelId')).toBe('model_id')
    expect(toSnakeCase('chunkOpts')).toBe('chunk_opts')
  })

  it('keep a name already lowercase', () => {
    expect(toSnakeCase('text')).toBe('text')
  })

  it('escape a Python keyword with a trailing underscore', () => {
    expect(toSnakeCase('from')).toBe('from_')
  })
})

describe('the client-to-contract map', () => {
  const methods = new Set(['translate', 'completionStream', 'rag', 'pluginInvoke'])

  it('matches a shared name, then the Stream suffix', () => {
    expect(contractTargetOf('translate', methods)).toEqual({ method: 'translate' })
    expect(contractTargetOf('completion', methods)).toEqual({ method: 'completionStream' })
  })

  it('maps a multiplexed function to its variant', () => {
    expect(contractTargetOf('ragIngest', methods)).toEqual({
      method: 'rag',
      variant: { field: 'operation', value: 'ingest' },
    })
  })

  it('gives no target to a function that reaches no method', () => {
    expect(contractTargetOf('vlaHparams', methods)).toBeNull()
  })
})

describe('the schema reader', () => {
  const reader = new SchemaReader({
    $defs: {
      Opts: { type: 'object', properties: { size: { type: 'integer', minimum: 1 } }, required: ['size'] },
      'demo.request': {
        oneOf: [
          {
            title: 'DemoA',
            type: 'object',
            properties: {
              type: { const: 'demo' },
              mode: { enum: ['a', 'b'], description: 'The mode.' },
              opts: { $ref: '#/$defs/Opts' },
            },
            required: ['type', 'mode'],
          },
          { title: 'DemoB', type: 'object', properties: { type: { const: 'demo' }, tags: { type: 'array', items: { type: 'string' } } } },
        ],
      },
    },
  })

  it('reads a union of objects as titled variants, hiding wire-only fields', () => {
    const shape = reader.shapeOf(reader.definition('demo.request')!, new Set(['type']))
    expect(shape?.kind).toBe('variants')
    if (shape?.kind !== 'variants') return
    expect(shape.variants.map((variant) => variant.label)).toEqual(['DemoA', 'DemoB'])
    expect(shape.variants[0].shape.fields.map((field) => field.name)).toEqual(['mode', 'opts'])
  })

  it('labels literals, arrays, and references, and expands nested objects', () => {
    const shape = reader.shapeOf(reader.definition('demo.request')!, new Set(['type']))
    if (shape?.kind !== 'variants') throw new Error('variants expected')
    const [mode, opts] = shape.variants[0].shape.fields
    expect(mode).toMatchObject({ type: '"a" | "b"', required: true, description: 'The mode.' })
    expect(opts.shape).toEqual({
      kind: 'object',
      fields: [{ name: 'size', required: true, type: 'number', constraints: ['≥ 1'], description: undefined, default: undefined, values: undefined, shape: undefined }],
    })
    expect(shape.variants[1].shape.fields[0].type).toBe('string[]')
  })

  it('writes a shape as a TypeScript type with comments', () => {
    const shape = reader.shapeOf(reader.definition('demo.request')!, new Set(['type']))!
    const text = shapeAsTypeScript(shape)
    expect(text).toContain('| // DemoA')
    expect(text).toContain('mode: "a" | "b" // The mode')
    expect(text).toContain('size: number // ≥ 1')
  })

  it('inlines references for a self-contained schema slice', () => {
    const slice = inline(reader, reader.definition('demo.request')) as { oneOf: { properties: { opts: unknown } }[] }
    expect(slice.oneOf[0].properties.opts).toMatchObject({ type: 'object', properties: { size: { type: 'integer' } } })
  })
})

describe('the line a page belongs to', () => {
  it('reads the current line, an explicit line, and the unreleased preview', () => {
    expect(lineOfUrl('/sdk/reference/api/translate')?.base).toBe('/sdk')
    expect(lineOfUrl('/sdk/v0.22/reference/api/translate')?.base).toBe('/sdk/v0.22')
    expect(lineOfUrl('/sdk/preview/reference/api/translate')).toMatchObject({ version: 'preview', base: '/sdk/preview' })
  })

  it('is none outside a documented software', () => {
    expect(lineOfUrl('/resources/troubleshooting')).toBeNull()
  })
})

describe('the SDK reference, read from the working tree', () => {
  const api = loadLineApi(MONOREPO, SDK_PATHS, '/sdk') as LineApi

  it('finds the contract and the generated surface data', () => {
    expect(api).not.toBeNull()
    expect(api.js.length).toBeGreaterThan(0)
    expect(api.python.length).toBeGreaterThan(0)
  })

  it('gives translate its NMT and LLM forms, without the wire discriminator', () => {
    const reference = functionReference(api, 'translate')!
    expect(reference.request?.kind).toBe('variants')
    if (reference.request?.kind !== 'variants') return
    expect(reference.request.variants).toHaveLength(2)
    for (const variant of reference.request.variants) {
      expect(variant.shape.fields.map((field) => field.name)).not.toContain('type')
    }
    expect(reference.pythonSignature).toContain('def translate(')
  })

  it('narrows a multiplexed function to its own variant', () => {
    const reference = functionReference(api, 'ragIngest')!
    expect(reference.request?.kind).toBe('object')
    if (reference.request?.kind !== 'object') return
    expect(reference.request.fields.map((field) => field.name)).toContain('documents')
    expect(reference.request.fields.map((field) => field.name)).not.toContain('operation')
  })

  it("writes a card with the signature, the fields, and the schema's address", () => {
    const card = functionCard(functionReference(api, 'translate')!)
    expect(card).toContain('## Signature')
    expect(card).toContain('```python')
    expect(card).toContain('type Request =')
    expect(card).toContain('translate.schema.json')
  })

  it('lists the registry models of an engine', () => {
    const models = modelsForEngines(api, ['llamacpp-decision'])
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.engine === 'llamacpp-decision')).toBe(true)
  })
})

describe('language parity', () => {
  it('names a method no language reaches', () => {
    const api = {
      methods: new Map([['embed', {} as never], ['orphan', {} as never]]),
      js: [{ name: 'embed' }],
      python: [{ name: 'embed' }],
    } as unknown as LineApi
    expect(parityGaps(api)).toEqual(['orphan: no JavaScript function calls it', 'orphan: no Python function `orphan`'])
  })
})
