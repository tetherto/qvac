import test from 'brittle'
import {
  llmConfigBaseSchema,
  llmConfigSchema,
  REASONING_BUDGET_MAX
} from '@/schemas/llamacpp-config'
import { loadModelOptionsToRequestSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { ModelType, deviceConfigDefaultsSchema } from '@/schemas'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'

const LLM_BASE = {
  modelType: ModelType.llamacppCompletion,
  modelSrc: 'model.gguf'
}

test('llmConfigSchema: preserves ordered RPC endpoints and device selection', (t) => {
  for (const servers of ['10.0.0.2:50052', '10.0.0.3:50052,10.0.0.2:50052']) {
    const config = llmConfigSchema.parse({ rpcServers: servers, devices: 'RPC0' })
    t.is(config.rpcServers, servers)
    t.is(config.devices, 'RPC0')
  }
})

test('llmConfigSchema: rejects duplicate RPC endpoints before native registration', (t) => {
  for (const servers of [
    '10.0.0.2:50052,10.0.0.2:50052,10.0.0.3:50052',
    '10.0.0.2:50052,10.0.0.3:50052,10.0.0.2:50052',
    '10.0.0.2:50052, 10.0.0.2:50052'
  ]) {
    const result = llmConfigSchema.safeParse({ rpcServers: servers })
    t.is(result.success, false)
    if (!result.success) {
      t.alike(result.error.issues[0]?.path, ['rpcServers'])
      t.is(result.error.issues[0]?.message, 'RPC server endpoints must be unique')
    }
  }
})

test('llmConfigBaseSchema: accepts supported splitMode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ splitMode: 'none' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ splitMode: 'layer' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ splitMode: 'tensor' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid splitMode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ splitMode: 'column' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ splitMode: 'row' }).success, false)
})

test('llmConfigBaseSchema: accepts valid flashAttention values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ flashAttention: 'on' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ flashAttention: 'off' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ flashAttention: 'auto' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid flashAttention values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ flashAttention: 'enabled' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ flashAttention: true }).success, false)
})

test('llmConfigBaseSchema: splitMode is optional', (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true)
})

test('llmConfigBaseSchema: accepts every loadMode value', (t) => {
  for (const loadMode of ['none', 'mmap', 'mlock', 'mmap+mlock', 'dio'] as const) {
    const result = llmConfigBaseSchema.safeParse({ loadMode })
    t.is(result.success, true, `${loadMode} must be accepted`)
    if (result.success) t.is(result.data.loadMode, loadMode)
  }
})

test('llmConfigBaseSchema: rejects invalid loadMode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ loadMode: 'buffered' }).success, false)
})

test('llmConfigBaseSchema: rejects legacy no_mmap under strict validation', (t) => {
  t.is(llmConfigBaseSchema.strict().safeParse({ no_mmap: true }).success, false)
})

test('llmConfigBaseSchema: rejects retired n_discarded under strict validation', (t) => {
  t.is(llmConfigBaseSchema.strict().safeParse({ n_discarded: 256 }).success, false)
})

test('loadModelOptionsToRequestSchema: rejects retired n_discarded for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { n_discarded: 256 }
    }).success,
    false
  )
})

// The deliberate retirement shape (#3380/#3999): outside the strict options
// path the retired key is inert — loads keep working and the key is dropped.
test('retired n_discarded strips, not rejects, on the wire and in deviceDefaults', (t) => {
  const wire = loadModelSrcRequestSchema.safeParse({
    type: 'loadModel',
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf',
    modelConfig: { ctxSize: 2048, n_discarded: 256 }
  })
  t.is(wire.success, true, 'the wire request still validates')
  const wireConfig = (wire.success ? wire.data : {}) as { modelConfig?: Record<string, unknown> }
  t.absent('n_discarded' in (wireConfig.modelConfig ?? {}), 'the key is dropped from the wire')
  t.is(wireConfig.modelConfig?.['ctxSize'], 2048, 'the rest of the config survives')

  const defaults = deviceConfigDefaultsSchema.safeParse({
    llm: { ctxSize: 2048, n_discarded: 256 }
  })
  t.is(defaults.success, true, 'deviceDefaults still validate')
  const llmDefaults = (defaults.success ? defaults.data : {}) as {
    llm?: Record<string, unknown>
  }
  t.absent('n_discarded' in (llmDefaults.llm ?? {}), 'the key is dropped from deviceDefaults')
})

test('llmConfigSchema: leaves loadMode unset by default', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.is(result.data.loadMode, undefined)
})

test('llmConfigBaseSchema: accepts continuous-batching parallel slots', (t) => {
  const result = llmConfigBaseSchema.safeParse({ parallel: 4 })
  t.is(result.success, true)
  if (result.success) t.is(result.data.parallel, 4)
})

test('llmConfigBaseSchema: rejects invalid parallel values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ parallel: 0 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ parallel: 1.5 }).success, false)
})

test('llmConfigBaseSchema: accepts tensorSplit string', (t) => {
  const result = llmConfigBaseSchema.safeParse({ tensorSplit: '1,1' })
  t.is(result.success, true)
  if (result.success) t.is(result.data.tensorSplit, '1,1')
})

test('llmConfigBaseSchema: accepts mainGpu as integer device index', (t) => {
  const result = llmConfigBaseSchema.safeParse({ mainGpu: 0 })
  t.is(result.success, true)
  if (result.success) t.is(result.data.mainGpu, 0)
})

test("llmConfigBaseSchema: accepts mainGpu as 'integrated' or 'dedicated'", (t) => {
  t.is(llmConfigBaseSchema.safeParse({ mainGpu: 'integrated' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ mainGpu: 'dedicated' }).success, true)
})

test('llmConfigBaseSchema: rejects mainGpu invalid string', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ mainGpu: 'hello' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ mainGpu: '0' }).success, false)
})

test('loadModelOptionsToRequestSchema: accepts splitMode for LLM', (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    ...LLM_BASE,
    modelConfig: { splitMode: 'layer' }
  })
  t.is(result.success, true)
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { splitMode: 'tensor', flashAttention: 'on', ctxSize: 8192 }
    }).success,
    true
  )
})

test('loadModelOptionsToRequestSchema: accepts mainGpu integer and named GPUs for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { splitMode: 'layer', tensorSplit: '1,1', mainGpu: 0 }
    }).success,
    true
  )
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { mainGpu: 'integrated' }
    }).success,
    true
  )
})

test('loadModelOptionsToRequestSchema: rejects mainGpu invalid string for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { mainGpu: 'hello' }
    }).success,
    false
  )
})

test('loadModelSrcRequestSchema: accepts splitMode for LLM', (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: 'loadModel',
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf',
    modelConfig: { splitMode: 'layer', tensorSplit: '3,1', mainGpu: 0 }
  })
  t.is(result.success, true)
})

test('llmConfigBaseSchema: accepts reasoningBudget -1 (unrestricted)', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: -1 }).success, true)
})

test('llmConfigBaseSchema: accepts reasoningBudget 0 (disabled)', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: 0 }).success, true)
})

test('llmConfigBaseSchema: accepts positive reasoningBudget (token cap)', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: 1 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: 128 }).success, true)
})

test('llmConfigBaseSchema: rejects reasoningBudget other values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: -2 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: 0.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ reasoningBudget: REASONING_BUDGET_MAX + 1 }).success, false)
})

test('llmConfigBaseSchema: accepts cacheCheckpoints from 0 to 1024', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: 0 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: 2 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: 1024 }).success, true)
})

test('llmConfigBaseSchema: rejects cacheCheckpoints the addon refuses', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: -1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: 1025 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: 1.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpoints: '2' }).success, false)
})

test('llmConfigSchema: does not inject a default for cacheCheckpoints', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.absent('cacheCheckpoints' in result.data)
})

test('loadModelOptionsToRequestSchema: accepts cacheCheckpoints for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { cacheCheckpoints: 2 }
    }).success,
    true
  )
})

test('llmConfigBaseSchema: accepts the checkpoint budget and storage keys', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointsMaxBytes: 0 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointsMaxBytes: 8589934592 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointStorage: 'memory' }).success, true)
  t.is(
    llmConfigBaseSchema.safeParse({
      cacheCheckpointStorage: 'disk',
      cacheCheckpointDir: '/data/cache'
    }).success,
    true
  )
})

test('llmConfigBaseSchema: rejects checkpoint budget and storage values the addon refuses', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointsMaxBytes: -1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointsMaxBytes: 0.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointsMaxBytes: '1024' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointStorage: 'ram' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointDir: '' }).success, false)
})

test('llmConfigBaseSchema: leaves the disk storage and directory pairing to the addon', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointStorage: 'disk' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheCheckpointDir: '/data/cache' }).success, true)
})

test('llmConfigBaseSchema: accepts cacheRamMib from 0 to 1048576', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: 0 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: 2048 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: 1048576 }).success, true)
})

test('llmConfigBaseSchema: rejects cacheRamMib the addon refuses', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: -1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: 1048577 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: 1.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ cacheRamMib: '2048' }).success, false)
})

test('llmConfigSchema: does not inject a default for the other prompt-cache keys', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) {
    t.absent('cacheCheckpointsMaxBytes' in result.data)
    t.absent('cacheCheckpointStorage' in result.data)
    t.absent('cacheCheckpointDir' in result.data)
    t.absent('cacheRamMib' in result.data)
  }
})

test('llmConfigSchema: keeps each conversation to its own cache unless sharing is asked for', (t) => {
  t.is(llmConfigSchema.parse({}).cacheShareAcrossKeys, false)
  t.is(llmConfigSchema.parse({ cacheShareAcrossKeys: true }).cacheShareAcrossKeys, true)
  t.is(llmConfigBaseSchema.safeParse({ cacheShareAcrossKeys: 'false' }).success, false)
})

test('transformLlmConfig: passes the cache sharing choice to the addon as a string', (t) => {
  t.is(transformLlmConfig(llmConfigSchema.parse({}))['cache_share_across_keys'], 'false')
  t.is(
    transformLlmConfig(llmConfigSchema.parse({ cacheShareAcrossKeys: true }))[
      'cache_share_across_keys'
    ],
    'true'
  )
})

test('loadModelOptionsToRequestSchema: keeps the other prompt-cache keys for LLM', (t) => {
  const modelConfig = {
    cacheCheckpointsMaxBytes: 1073741824,
    cacheCheckpointStorage: 'disk',
    cacheCheckpointDir: '/data/cache',
    cacheRamMib: 512
  }
  const result = loadModelOptionsToRequestSchema.safeParse({ ...LLM_BASE, modelConfig })
  t.is(result.success, true)
  if (result.success) t.alike(result.data.modelConfig, modelConfig)
})

test('llmConfigBaseSchema: accepts valid imageTileMode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ imageTileMode: 'disabled' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ imageTileMode: 'batched' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ imageTileMode: 'sequential' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid imageTileMode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ imageTileMode: 'tiled' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageTileMode: 0 }).success, false)
})

test('llmConfigBaseSchema: imageTileMode is optional', (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true)
})

test('llmConfigSchema: defaults imageTileMode to sequential', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.is(result.data.imageTileMode, 'sequential')
})

test('llmConfigSchema: explicit imageTileMode overrides the default', (t) => {
  const result = llmConfigSchema.safeParse({ imageTileMode: 'batched' })
  t.is(result.success, true)
  if (result.success) t.is(result.data.imageTileMode, 'batched')
})

test('llmConfigBaseSchema: accepts valid imageNoUpscale values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ imageNoUpscale: 'on' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ imageNoUpscale: 'off' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid imageNoUpscale values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ imageNoUpscale: true }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageNoUpscale: 1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageNoUpscale: 'yes' }).success, false)
})

// Unset must stay unset. The addon reads absence as fabric's -1 sentinel, meaning
// "use the model's own GGUF value"; a default here would force one rule on every
// model and silently change preprocessing for existing callers.
test('llmConfigBaseSchema: imageNoUpscale is optional and has no default', (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true)
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.is(result.data.imageNoUpscale, undefined)
})

// The regression this guards: load-model.ts validates modelConfig with
// llmConfigBaseSchema.strict(), so a field present in the SDK copy of this schema but
// missing here is rejected before it ever reaches the addon.
test('loadBuiltinModelOptions: strict validation admits imageNoUpscale', (t) => {
  t.is(llmConfigBaseSchema.strict().safeParse({ imageNoUpscale: 'on' }).success, true)
})

test('llmConfigBaseSchema: accepts mmprojUseGpu boolean', (t) => {
  const enabled = llmConfigBaseSchema.safeParse({ mmprojUseGpu: true })
  t.is(enabled.success, true)
  if (enabled.success) t.is(enabled.data.mmprojUseGpu, true)
  const disabled = llmConfigBaseSchema.safeParse({ mmprojUseGpu: false })
  t.is(disabled.success, true)
  if (disabled.success) t.is(disabled.data.mmprojUseGpu, false)
})

test('llmConfigBaseSchema: rejects non-boolean mmprojUseGpu', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ mmprojUseGpu: 'true' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ mmprojUseGpu: 1 }).success, false)
})

test('llmConfigBaseSchema: mmprojUseGpu is optional (auto-default when unset)', (t) => {
  const result = llmConfigBaseSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.absent('mmprojUseGpu' in result.data)
})

test('llmConfigSchema: does not inject a default for mmprojUseGpu', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.absent('mmprojUseGpu' in result.data)
})

test('loadModelOptionsToRequestSchema: accepts mmprojUseGpu for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { mmprojUseGpu: true }
    }).success,
    true
  )
})

test('llmConfigBaseSchema: accepts a positive integer imageMaxMegapixels', (t) => {
  const result = llmConfigBaseSchema.safeParse({ imageMaxMegapixels: 20 })
  t.is(result.success, true)
  if (result.success) t.is(result.data.imageMaxMegapixels, 20)
})

test('llmConfigBaseSchema: rejects invalid imageMaxMegapixels', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ imageMaxMegapixels: 0 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageMaxMegapixels: 1.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageMaxMegapixels: '20' }).success, false)
})

test('llmConfigBaseSchema: bounds imageMaxMegapixels at the addon maximum', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ imageMaxMegapixels: 18_446_744_073_709 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ imageMaxMegapixels: 18_446_744_073_710 }).success, false)
})

test('llmConfigSchema: does not inject a default for imageMaxMegapixels', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.absent('imageMaxMegapixels' in result.data)
})

test('loadModelOptionsToRequestSchema: accepts imageMaxMegapixels for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { imageMaxMegapixels: 100 }
    }).success,
    true
  )
})

test('llmConfigBaseSchema: accepts valid tensorReadLazy values', (t) => {
  for (const value of ['on', 'auto', 'off']) {
    t.is(llmConfigBaseSchema.safeParse({ tensorReadLazy: value }).success, true)
  }
})

test('llmConfigBaseSchema: rejects invalid tensorReadLazy values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ tensorReadLazy: 'yes' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ tensorReadLazy: true }).success, false)
})

test('llmConfigBaseSchema: accepts both forms of moeCacheMib', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ moeCacheMib: 2048 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ moeCacheMib: 'auto' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid moeCacheMib values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ moeCacheMib: -1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ moeCacheMib: 2048.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ moeCacheMib: 'default' }).success, false)
})

test('llmConfigBaseSchema: accepts both forms of prefetchWeights', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ prefetchWeights: true }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ prefetchWeights: 'auto' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid prefetchWeights values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ prefetchWeights: 'on' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ prefetchWeights: 1 }).success, false)
})

test('llmConfigBaseSchema: accepts Core ML FFN splits in METALxN form', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnSplit: '2048x1' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnSplit: '8192x2' }).success, true)
})

test('llmConfigBaseSchema: rejects Core ML FFN splits fabric refuses', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnSplit: '2048' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnSplit: '2048x3' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnSplit: '0x1' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnSplit: '2048x1 ' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ coremlFfnCache: '' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ coremlFfn: 'true' }).success, false)
})

test('llmConfigSchema: Core ML FFN split requires coremlFfn, the cache does not', (t) => {
  const split = llmConfigSchema.safeParse({ coremlFfnSplit: '3072x1' })
  t.is(split.success, false)
  t.is(split.error?.issues[0]?.path[0], 'coremlFfnSplit')
  t.is(llmConfigSchema.safeParse({ coremlFfn: false, coremlFfnCache: '/tmp/c' }).success, true)
  t.is(llmConfigSchema.safeParse({ coremlFfnCache: '/tmp/c' }).success, true)
  t.is(
    llmConfigSchema.safeParse({
      coremlFfn: true,
      coremlFfnSplit: '3072x1',
      coremlFfnCache: '/tmp/c'
    }).success,
    true
  )
})

test('llmConfigBaseSchema: accepts both forms of fitTarget', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ fitTarget: 512 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ fitTarget: '1024,512' }).success, true)
})

test('llmConfigBaseSchema: rejects fitTarget values fabric would misparse', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ fitTarget: 'nonsense' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ fitTarget: '512abc' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ fitTarget: '-1' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ fitTarget: -1 }).success, false)
})

test('llmConfigBaseSchema: rejects non-positive batch and ubatch sizes', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ batchSize: 0 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ ubatchSize: 0 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageMaxTokens: 0 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ imageMinTokens: 0 }).success, false)
})

test('llmConfigBaseSchema: rejects negative layer counts', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ nCpuMoe: -1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ nCpuFfn: -1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ fitCtx: -1 }).success, false)
})

test('llmConfigSchema: gpuLayers stays unset', (t) => {
  t.absent('gpuLayers' in llmConfigSchema.parse({}))
  t.absent('gpuLayers' in llmConfigSchema.parse({ fit: true }))
  t.absent('gpuLayers' in llmConfigSchema.parse({ fit: false }))
})

test('llmConfigSchema: an explicit gpuLayers is kept', (t) => {
  t.is(llmConfigSchema.parse({ gpuLayers: 20 }).gpuLayers, 20)
  t.is(llmConfigSchema.parse({ fit: true, gpuLayers: 20 }).gpuLayers, 20)
})

test('llmConfigBaseSchema: accepts every specType value', (t) => {
  for (const value of ['none', 'draft-mtp', 'draft-dflash', 'draft-dspark', 'auto']) {
    t.is(llmConfigBaseSchema.safeParse({ specType: value }).success, true)
  }
  t.is(llmConfigBaseSchema.safeParse({ specType: 'draft-eagle' }).success, false)
})

test('llmConfigBaseSchema: bounds the speculative draft limits at the addon ranges', (t) => {
  for (const value of [1, 64]) {
    t.is(llmConfigBaseSchema.safeParse({ specDraftNMax: value }).success, true)
  }
  for (const value of [0, 65, 2.5]) {
    t.is(llmConfigBaseSchema.safeParse({ specDraftNMax: value }).success, false)
  }
  for (const value of [0, 64]) {
    t.is(llmConfigBaseSchema.safeParse({ specDraftNMin: value }).success, true)
  }
  for (const value of [-1, 65, 1.5]) {
    t.is(llmConfigBaseSchema.safeParse({ specDraftNMin: value }).success, false)
  }
  for (const value of [0, 0.75, 1]) {
    t.is(llmConfigBaseSchema.safeParse({ specDraftPMin: value }).success, true)
  }
  for (const value of [-0.1, 1.1]) {
    t.is(llmConfigBaseSchema.safeParse({ specDraftPMin: value }).success, false)
  }
})

test('llmConfigBaseSchema: leaves the n_min / n_max relation to the addon', (t) => {
  t.is(
    llmConfigBaseSchema.safeParse({
      specType: 'draft-mtp',
      specDraftNMax: 2,
      specDraftNMin: 5
    }).success,
    true
  )
})

test('llmConfigSchema: injects no speculative defaults', (t) => {
  const result = llmConfigSchema.parse({})
  t.absent('specType' in result)
  t.absent('specDraftNMax' in result)
})

test('loadModelOptionsToRequestSchema: accepts draft-dflash with a draftModelSrc for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: {
        specType: 'draft-dflash',
        specDraftNMax: 7,
        draftModelSrc: 'https://example.com/dflash.gguf'
      }
    }).success,
    true
  )
})

test('loadModelOptionsToRequestSchema: accepts draft-mtp with a draftModelSrc for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { specType: 'draft-mtp', draftModelSrc: 'https://example.com/mtp.gguf' }
    }).success,
    true
  )
})

test('llmConfigSchema: rejects a draftModelSrc without speculative decoding', (t) => {
  for (const config of [
    { draftModelSrc: 'https://example.com/dflash.gguf' },
    { specType: 'none', draftModelSrc: 'https://example.com/dflash.gguf' }
  ]) {
    const result = llmConfigSchema.safeParse(config)
    t.is(result.success, false)
    t.alike(result.error?.issues[0]?.path, ['draftModelSrc'])
    t.is(
      result.error?.issues[0]?.message,
      "draftModelSrc requires specType 'draft-mtp', 'draft-dflash', 'draft-dspark' or 'auto'."
    )
  }
})

test('llmConfigSchema: rejects a drafter specType without a draftModelSrc', (t) => {
  for (const specType of ['draft-dflash', 'draft-dspark', 'auto'] as const) {
    for (const config of [{ specType }, { specType, draftModelSrc: '' }]) {
      const result = llmConfigSchema.safeParse(config)
      t.is(result.success, false)
      t.alike(result.error?.issues[0]?.path, ['draftModelSrc'])
      t.is(result.error?.issues[0]?.message, `specType '${specType}' requires draftModelSrc.`)
    }
  }
})

test('llmConfigSchema: accepts draft-mtp without a draftModelSrc', (t) => {
  t.is(llmConfigSchema.safeParse({ specType: 'draft-mtp' }).success, true)
})

test('llmConfigSchema: accepts a draftModelSrc with speculative decoding', (t) => {
  for (const specType of ['draft-mtp', 'draft-dflash', 'draft-dspark', 'auto'] as const) {
    t.is(
      llmConfigSchema.safeParse({ specType, draftModelSrc: 'https://example.com/draft.gguf' })
        .success,
      true
    )
  }
})

test('llmConfigBaseSchema: leaves the draftModelSrc / specType pairing to the merged config', (t) => {
  t.is(
    llmConfigBaseSchema.safeParse({ draftModelSrc: 'https://example.com/draft.gguf' }).success,
    true
  )
  t.ok(llmConfigBaseSchema.pick({ draftModelSrc: true }))
})
