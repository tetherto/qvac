import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelConstant } from '@qvac/sdk'
import { createModelRegistry } from '@/serve/core/model-registry'
import type { ResolvedModelEntry, ServeConfig } from '@/serve/core/model-registry'
import { buildCatalog, filterCatalog, paginate } from '@/serve/core/model-catalog'

function constant(name: string, over: Partial<ModelConstant> = {}): ModelConstant {
  return {
    name,
    src: `registry://x/${name}`,
    registryPath: `x/${name}`,
    registrySource: 'hf',
    blobCoreKey: 'k',
    blobBlockOffset: 0,
    blobBlockLength: 0,
    blobByteOffset: 0,
    modelId: `${name}.gguf`,
    expectedSize: 1000,
    sha256Checksum: 'sha',
    addon: 'llm',
    engine: 'llamacpp-completion',
    quantization: 'q4',
    params: '600M',
    ...over
  } as ModelConstant
}

function serveConfig(models: Map<string, ResolvedModelEntry>): ServeConfig {
  return { models } as unknown as ServeConfig
}

function resolved(over: Partial<ResolvedModelEntry> & { alias: string }): ResolvedModelEntry {
  return {
    modelSrc: 'hyper://x/y',
    sdkType: 'whispercpp-transcription',
    endpointCategory: 'transcription',
    isDefault: false,
    preload: false,
    config: {},
    ...over
  } as ResolvedModelEntry
}

describe('model-catalog', () => {
  it('marks a built-in constant not_configured / not usable, with size + role', () => {
    const cat = buildCatalog(
      serveConfig(new Map()),
      createModelRegistry(),
      new Map([['QWEN', constant('QWEN')]])
    )
    const e = cat.find((x) => x.id === 'QWEN')!
    assert.equal(e.source, 'builtin')
    assert.equal(e.configured, false)
    assert.equal(e.usable, false)
    assert.equal(e.state, 'not_configured')
    assert.equal(e.role, 'chat')
    assert.equal(e.addon, 'llm')
    assert.equal(e.quantization, 'q4')
    assert.equal(e.size, 1000)
    assert.ok(e.hint)
  })

  it('marks a configured constant-backed model configured/usable with registry state', () => {
    const reg = createModelRegistry()
    reg.register('my-llm', {
      modelSrc: constant('QWEN'),
      sdkType: 'llamacpp-completion',
      endpointCategory: 'chat',
      config: {}
    })
    reg.setReady('my-llm', 'sdk-1')
    const models = new Map([
      [
        'my-llm',
        resolved({
          alias: 'my-llm',
          modelSrc: constant('QWEN'),
          sdkType: 'llamacpp-completion',
          endpointCategory: 'chat'
        })
      ]
    ])
    const e = buildCatalog(serveConfig(models), reg, new Map()).find((x) => x.id === 'my-llm')!
    assert.equal(e.source, 'config')
    assert.equal(e.configured, true)
    assert.equal(e.usable, true)
    assert.equal(e.state, reg.STATES.READY)
    assert.equal(e.role, 'chat')
    assert.equal(e.size, 1000)
  })

  it('defaults a configured-but-unregistered model to idle', () => {
    const cat = buildCatalog(
      serveConfig(new Map([['a', resolved({ alias: 'a' })]])),
      createModelRegistry(),
      new Map()
    )
    assert.equal(cat.find((x) => x.id === 'a')!.state, 'idle')
  })

  it('filters by role, addon, quantization (case-insensitive) and search', () => {
    const constants = new Map([
      [
        'QWEN',
        constant('QWEN', { addon: 'llm', engine: 'llamacpp-completion', quantization: 'q4' })
      ],
      [
        'WHISP',
        constant('WHISP', {
          addon: 'whisper',
          engine: 'whispercpp-transcription',
          quantization: 'q8_0'
        })
      ]
    ])
    const cat = buildCatalog(serveConfig(new Map()), createModelRegistry(), constants)
    assert.deepEqual(
      filterCatalog(cat, { role: 'chat' }).map((e) => e.id),
      ['QWEN']
    )
    assert.deepEqual(
      filterCatalog(cat, { addon: 'whisper' }).map((e) => e.id),
      ['WHISP']
    )
    assert.deepEqual(
      filterCatalog(cat, { quantization: 'Q8_0' }).map((e) => e.id),
      ['WHISP']
    )
    assert.deepEqual(
      filterCatalog(cat, { search: 'qwe' }).map((e) => e.id),
      ['QWEN']
    )
    assert.deepEqual(
      filterCatalog(cat, { configured: false })
        .map((e) => e.id)
        .sort(),
      ['QWEN', 'WHISP']
    )
  })

  it('paginates with has_more', () => {
    const constants = new Map(
      Array.from({ length: 5 }, (_, i) => [`M${i}`, constant(`M${i}`)] as const)
    )
    const cat = buildCatalog(serveConfig(new Map()), createModelRegistry(), constants)
    const p = paginate(cat, 2, 0)
    assert.equal(p.data.length, 2)
    assert.equal(p.hasMore, true)
    const last = paginate(cat, 2, 4)
    assert.equal(last.data.length, 1)
    assert.equal(last.hasMore, false)
    // Omitted limit → everything, no more pages.
    const all = paginate(cat)
    assert.equal(all.data.length, 5)
    assert.equal(all.hasMore, false)
  })
})
