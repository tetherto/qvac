import test from 'brittle'
import { ModelType, type RuntimeContext, type DevicePattern } from '@/schemas'
import { LLM_CONFIG_DEFAULTS, EMBED_CONFIG_DEFAULTS } from '@/schemas/llamacpp-config'
import {
  matchesPattern,
  findAllMatchingPatterns,
  getDefaultsFromPattern,
  resolveModelConfigWithContext,
  CANONICAL_TO_ALIAS,
  BUILTIN_DEVICE_PATTERNS,
  type ConfigResolutionLog
} from '@/runtime/model-config-utils'

test('matchesPattern: matches Pixel device', (t) => {
  const ctx: RuntimeContext = {
    platform: 'android',
    deviceModel: 'Pixel 10 Pro',
    deviceBrand: 'google'
  }

  t.ok(matchesPattern(ctx, { platform: 'android' }))
  t.ok(matchesPattern(ctx, { deviceBrand: 'google' }))
  t.ok(matchesPattern(ctx, { deviceModelPrefix: 'Pixel' }))
  t.ok(
    matchesPattern(ctx, {
      platform: 'android',
      deviceBrand: 'google',
      deviceModelPrefix: 'Pixel'
    })
  )
})

test('matchesPattern: rejects non-matching', (t) => {
  const ctx: RuntimeContext = {
    platform: 'ios',
    deviceModel: 'iPhone 15',
    deviceBrand: 'Apple'
  }

  t.absent(matchesPattern(ctx, { platform: 'android' }))
  t.absent(matchesPattern(ctx, { deviceBrand: 'google' }))
  t.absent(matchesPattern(ctx, { deviceModelPrefix: 'Pixel' }))
})

test('findAllMatchingPatterns: returns all matches', (t) => {
  const ctx: RuntimeContext = { platform: 'android', deviceBrand: 'google' }
  const patterns: DevicePattern[] = [
    { name: 'General', match: { platform: 'android' }, defaults: {} },
    {
      name: 'Specific',
      match: { platform: 'android', deviceBrand: 'google' },
      defaults: {}
    },
    { name: 'iOS only', match: { platform: 'ios' }, defaults: {} }
  ]

  const result = findAllMatchingPatterns(ctx, patterns)
  t.is(result.length, 2)
  t.is(result[0].name, 'General')
  t.is(result[1].name, 'Specific')
})

test('getDefaultsFromPattern: canonical key', (t) => {
  const pattern: DevicePattern = {
    name: 'Test',
    match: {},
    defaults: {
      [ModelType.llamacppCompletion]: { device: 'cpu' }
    }
  }

  const result = getDefaultsFromPattern(ModelType.llamacppCompletion, pattern)
  t.alike(result, { device: 'cpu' })
})

test('getDefaultsFromPattern: alias key fallback', (t) => {
  const pattern: DevicePattern = {
    name: 'Test',
    match: {},
    defaults: {
      llm: { device: 'cpu' }
    }
  }

  const result = getDefaultsFromPattern(ModelType.llamacppCompletion, pattern)
  t.alike(result, { device: 'cpu' })
})

test('CANONICAL_TO_ALIAS: correct mappings', (t) => {
  t.is(CANONICAL_TO_ALIAS[ModelType.llamacppCompletion], 'llm')
  t.is(CANONICAL_TO_ALIAS[ModelType.llamacppEmbedding], 'embeddings')
  t.is(CANONICAL_TO_ALIAS[ModelType.whispercppTranscription], 'whisper')
})

test('no patterns match = schema defaults only', (t) => {
  const ctx: RuntimeContext = { runtime: 'node', platform: 'darwin' }
  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    []
  )

  t.is(result.device, LLM_CONFIG_DEFAULTS.device)
  t.is(result.ctxSize, LLM_CONFIG_DEFAULTS.ctxSize)
})

// A resolved config carries a system prompt only when the caller configures one.
test('no systemPrompt default is injected', (t) => {
  const ctx: RuntimeContext = { runtime: 'node', platform: 'darwin' }

  t.absent('systemPrompt' in LLM_CONFIG_DEFAULTS, 'not in the schema defaults')

  const resolved = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    []
  )
  t.absent('systemPrompt' in resolved, 'absent when the caller sets none')

  const configured = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { systemPrompt: 'Answer in French.' },
    ctx,
    [],
    []
  )
  t.is(configured.systemPrompt, 'Answer in French.', 'a configured prompt is kept')
})

// gpuLayers stays absent from a resolved config unless the caller sets it.
test('no gpuLayers default is injected, so the runtime fit can run', (t) => {
  const ctx: RuntimeContext = { runtime: 'node', platform: 'darwin' }

  t.absent('gpuLayers' in LLM_CONFIG_DEFAULTS, 'not in the schema defaults')

  const resolved = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    []
  )
  t.absent('gpuLayers' in resolved, 'not in a resolved config either')

  // The escape hatch still works: an explicit value is passed through, and
  // pinning the layer count is what turns the fit off.
  const pinned = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { gpuLayers: 12 },
    ctx,
    [],
    []
  )
  t.is(pinned.gpuLayers, 12, 'an explicit gpuLayers still pins the count')
})

// Resolution parses through the permissive base schema, so the retired key
// is dropped here too rather than failing the load.
test('config resolution strips retired n_discarded instead of rejecting it', (t) => {
  const ctx: RuntimeContext = { runtime: 'node', platform: 'darwin' }
  const resolved = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { ctxSize: 2048, n_discarded: 256 },
    ctx,
    [],
    []
  )
  t.absent('n_discarded' in resolved, 'the retired key is dropped')
  t.is(resolved.ctxSize, 2048, 'the rest of the config survives')
})

test('multiple patterns merge (general → specific)', (t) => {
  const ctx: RuntimeContext = { platform: 'android', deviceBrand: 'google' }
  const builtinPatterns: DevicePattern[] = [
    {
      name: 'General Android',
      match: { platform: 'android' },
      defaults: {
        [ModelType.llamacppCompletion]: { device: 'vulkan', gpuLayers: 10 }
      }
    },
    {
      name: 'Google devices',
      match: { platform: 'android', deviceBrand: 'google' },
      defaults: { [ModelType.llamacppCompletion]: { device: 'cpu' } }
    }
  ]

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    builtinPatterns
  )

  t.is(result.device, 'cpu')
  t.is(result.gpuLayers, 10)
})

test('user input overrides all patterns', (t) => {
  const ctx: RuntimeContext = { platform: 'android' }
  const builtinPatterns: DevicePattern[] = [
    {
      name: 'Android',
      match: { platform: 'android' },
      defaults: {
        [ModelType.llamacppCompletion]: { device: 'cpu', gpuLayers: 0 }
      }
    }
  ]

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { device: 'gpu', ctxSize: 2048 },
    ctx,
    [],
    builtinPatterns
  )

  t.is(result.device, 'gpu')
  t.is(result.ctxSize, 2048)
  t.is(result.gpuLayers, 0)
})

test('user patterns override builtin patterns', (t) => {
  const ctx: RuntimeContext = { platform: 'android' }
  const builtinPatterns: DevicePattern[] = [
    {
      name: 'Builtin',
      match: { platform: 'android' },
      defaults: {
        [ModelType.llamacppCompletion]: { device: 'cpu', gpuLayers: 0 }
      }
    }
  ]
  const userPatterns: DevicePattern[] = [
    {
      name: 'User override',
      match: { platform: 'android' },
      defaults: { [ModelType.llamacppCompletion]: { device: 'vulkan' } }
    }
  ]

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    userPatterns,
    builtinPatterns
  )

  t.is(result.device, 'vulkan')
  t.is(result.gpuLayers, 0)
})

test('onLog callback reports applied patterns', (t) => {
  const ctx: RuntimeContext = { platform: 'android', deviceBrand: 'google' }
  const patterns: DevicePattern[] = [
    {
      name: 'Pattern A',
      match: { platform: 'android' },
      defaults: { [ModelType.llamacppCompletion]: { device: 'cpu' } }
    },
    {
      name: 'Pattern B',
      match: { platform: 'android', deviceBrand: 'google' },
      defaults: { [ModelType.llamacppCompletion]: { gpuLayers: 5 } }
    }
  ]

  let log: ConfigResolutionLog | undefined
  resolveModelConfigWithContext(ModelType.llamacppCompletion, {}, ctx, [], patterns, (l) => {
    log = l
  })

  t.ok(log)
  t.alike(log?.appliedPatterns, ['Pattern A', 'Pattern B'])
  t.is(log?.mergedDefaults.device, 'cpu')
  t.is(log?.mergedDefaults.gpuLayers, 5)
})

// ============================================
// Tests using actual BUILTIN_DEVICE_PATTERNS
// ============================================

test('BUILTIN: Pixel device gets cpu + flashAttention off', (t) => {
  const ctx: RuntimeContext = {
    runtime: 'react-native',
    platform: 'android',
    deviceModel: 'Pixel 10 Pro',
    deviceBrand: 'google'
  }

  let log: ConfigResolutionLog | undefined

  const llmResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l
    }
  )

  t.alike(log?.appliedPatterns, ['Pixel devices (default)'])
  t.is(llmResult.device, 'cpu')
  t.is(llmResult.ctxSize, LLM_CONFIG_DEFAULTS.ctxSize)

  const embedResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppEmbedding,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l
    }
  )

  t.alike(log?.appliedPatterns, ['Android devices (default)', 'Pixel devices (default)'])
  t.is(embedResult.device, 'cpu')
  t.is(embedResult.flashAttention, 'off')

  const rerankResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppRerank,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l
    }
  )

  t.alike(log?.appliedPatterns, ['Pixel devices (default)'])
  t.is(rerankResult.device, 'cpu')
})

test('BUILTIN: Non-Pixel Android gets flashAttention off only', (t) => {
  const ctx: RuntimeContext = {
    runtime: 'react-native',
    platform: 'android',
    deviceModel: 'Galaxy S24',
    deviceBrand: 'samsung'
  }

  let log: ConfigResolutionLog | undefined

  const llmResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l
    }
  )

  t.alike(log?.appliedPatterns, [])
  t.is(llmResult.device, LLM_CONFIG_DEFAULTS.device)

  const embedResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppEmbedding,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l
    }
  )

  t.alike(log?.appliedPatterns, ['Android devices (default)'])
  t.is(embedResult.device, EMBED_CONFIG_DEFAULTS.device)
  t.is(embedResult.flashAttention, 'off')
})

test('BUILTIN: iOS gets no device defaults', (t) => {
  const ctx: RuntimeContext = {
    runtime: 'react-native',
    platform: 'ios',
    deviceModel: 'iPhone 15 Pro',
    deviceBrand: 'Apple'
  }

  let log: ConfigResolutionLog | undefined

  const embedResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppEmbedding,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l
    }
  )

  t.alike(log?.appliedPatterns, [])
  t.is(embedResult.device, EMBED_CONFIG_DEFAULTS.device)
  t.is(embedResult.flashAttention, undefined)
})

test('BUILTIN: User can override device defaults', (t) => {
  const ctx: RuntimeContext = {
    runtime: 'react-native',
    platform: 'android',
    deviceModel: 'Pixel 10 Pro',
    deviceBrand: 'google'
  }

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { device: 'vulkan' },
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS
  )

  t.is(result.device, 'vulkan')
})

test('draftModelSrc pairs with a specType from device defaults', (t) => {
  const ctx: RuntimeContext = { platform: 'darwin' }
  const patterns: DevicePattern[] = [
    {
      name: 'Speculative',
      match: { platform: 'darwin' },
      defaults: { [ModelType.llamacppCompletion]: { specType: 'draft-mtp' } }
    }
  ]

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { draftModelSrc: 'https://example.com/head.gguf' },
    ctx,
    patterns,
    []
  )
  t.is(result.specType, 'draft-mtp')

  t.exception(
    () =>
      resolveModelConfigWithContext(
        ModelType.llamacppCompletion,
        { draftModelSrc: 'https://example.com/head.gguf' },
        ctx,
        [],
        []
      ),
    /draftModelSrc requires/
  )
})
