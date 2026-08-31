import test from 'brittle'
import {
  llmConfigBaseSchema,
  llmConfigSchema,
  REASONING_BUDGET_MAX
} from '@/schemas/llamacpp-config'
import { loadModelOptionsToRequestSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { ModelType, deviceConfigDefaultsSchema } from '@/schemas'

const LLM_BASE = {
  modelType: ModelType.llamacppCompletion,
  modelSrc: 'model.gguf'
}

test('llmConfigBaseSchema: accepts valid split-mode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ 'split-mode': 'none' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ 'split-mode': 'layer' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ 'split-mode': 'row' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid split-mode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ 'split-mode': 'column' }).success, false)
})

test('llmConfigBaseSchema: split-mode is optional', (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true)
})

test('llmConfigBaseSchema: accepts every load_mode value', (t) => {
  for (const load_mode of ['none', 'mmap', 'mlock', 'mmap+mlock', 'dio'] as const) {
    const result = llmConfigBaseSchema.safeParse({ load_mode })
    t.is(result.success, true, `${load_mode} must be accepted`)
    if (result.success) t.is(result.data.load_mode, load_mode)
  }
})

test('llmConfigBaseSchema: rejects invalid load_mode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ load_mode: 'buffered' }).success, false)
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

// The raw wire request must fail closed too: a non-strict modelConfig would
// strip the retired key and silently disable sliding for an older or
// hand-rolled client instead of failing the load.
test('loadModelSrcRequestSchema: rejects retired n_discarded for LLM', (t) => {
  t.is(
    loadModelSrcRequestSchema.safeParse({
      type: 'loadModel',
      modelType: ModelType.llamacppCompletion,
      modelSrc: 'model.gguf',
      modelConfig: { n_discarded: 256 }
    }).success,
    false
  )
})

// Same for a stale deployment config: deviceDefaults carrying the retired
// key must fail config validation, on the canonical key and the alias.
test('deviceConfigDefaultsSchema: rejects retired n_discarded on both keys', (t) => {
  t.is(
    deviceConfigDefaultsSchema.safeParse({
      [ModelType.llamacppCompletion]: { ctx_size: 2048, n_discarded: 256 }
    }).success,
    false
  )
  t.is(
    deviceConfigDefaultsSchema.safeParse({ llm: { ctx_size: 2048, n_discarded: 256 } }).success,
    false
  )
  t.is(deviceConfigDefaultsSchema.safeParse({ llm: { ctx_size: 2048 } }).success, true)
})

test('llmConfigSchema: leaves load_mode unset by default', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.is(result.data.load_mode, undefined)
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

test('llmConfigBaseSchema: accepts tensor-split string', (t) => {
  const result = llmConfigBaseSchema.safeParse({ 'tensor-split': '1,1' })
  t.is(result.success, true)
  if (result.success) t.is(result.data['tensor-split'], '1,1')
})

test('llmConfigBaseSchema: accepts main-gpu as integer device index', (t) => {
  const result = llmConfigBaseSchema.safeParse({ 'main-gpu': 0 })
  t.is(result.success, true)
  if (result.success) t.is(result.data['main-gpu'], 0)
})

test("llmConfigBaseSchema: accepts main-gpu as 'integrated' or 'dedicated'", (t) => {
  t.is(llmConfigBaseSchema.safeParse({ 'main-gpu': 'integrated' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ 'main-gpu': 'dedicated' }).success, true)
})

test('llmConfigBaseSchema: rejects main-gpu invalid string', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ 'main-gpu': 'hello' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ 'main-gpu': '0' }).success, false)
})

test('loadModelOptionsToRequestSchema: accepts split-mode for LLM', (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    ...LLM_BASE,
    modelConfig: { 'split-mode': 'layer' }
  })
  t.is(result.success, true)
})

test('loadModelOptionsToRequestSchema: accepts main-gpu integer and named GPUs for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { 'split-mode': 'layer', 'tensor-split': '1,1', 'main-gpu': 0 }
    }).success,
    true
  )
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { 'main-gpu': 'integrated' }
    }).success,
    true
  )
})

test('loadModelOptionsToRequestSchema: rejects main-gpu invalid string for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { 'main-gpu': 'hello' }
    }).success,
    false
  )
})

test('loadModelSrcRequestSchema: accepts split-mode for LLM', (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: 'loadModel',
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf',
    modelConfig: { 'split-mode': 'row', 'tensor-split': '3,1', 'main-gpu': 0 }
  })
  t.is(result.success, true)
})

test('llmConfigBaseSchema: accepts reasoning_budget -1 (unrestricted)', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: -1 }).success, true)
})

test('llmConfigBaseSchema: accepts reasoning_budget 0 (disabled)', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: 0 }).success, true)
})

test('llmConfigBaseSchema: accepts positive reasoning_budget (token cap)', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: 1 }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: 128 }).success, true)
})

test('llmConfigBaseSchema: rejects reasoning_budget other values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: -2 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: 0.5 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ reasoning_budget: REASONING_BUDGET_MAX + 1 }).success, false)
})

test('llmConfigBaseSchema: accepts valid image_tile_mode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ image_tile_mode: 'disabled' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ image_tile_mode: 'batched' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ image_tile_mode: 'sequential' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid image_tile_mode values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ image_tile_mode: 'tiled' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ image_tile_mode: 0 }).success, false)
})

test('llmConfigBaseSchema: image_tile_mode is optional', (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true)
})

test('llmConfigSchema: defaults image_tile_mode to sequential', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.is(result.data.image_tile_mode, 'sequential')
})

test('llmConfigSchema: explicit image_tile_mode overrides the default', (t) => {
  const result = llmConfigSchema.safeParse({ image_tile_mode: 'batched' })
  t.is(result.success, true)
  if (result.success) t.is(result.data.image_tile_mode, 'batched')
})

test('llmConfigBaseSchema: accepts valid image_no_upscale values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ image_no_upscale: 'on' }).success, true)
  t.is(llmConfigBaseSchema.safeParse({ image_no_upscale: 'off' }).success, true)
})

test('llmConfigBaseSchema: rejects invalid image_no_upscale values', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ image_no_upscale: true }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ image_no_upscale: 1 }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ image_no_upscale: 'yes' }).success, false)
})

// Unset must stay unset. The addon reads absence as fabric's -1 sentinel, meaning
// "use the model's own GGUF value"; a default here would force one rule on every
// model and silently change preprocessing for existing callers.
test('llmConfigBaseSchema: image_no_upscale is optional and has no default', (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true)
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.is(result.data.image_no_upscale, undefined)
})

// The regression this guards: load-model.ts validates modelConfig with
// llmConfigBaseSchema.strict(), so a field present in the SDK copy of this schema but
// missing here is rejected before it ever reaches the addon.
test('loadBuiltinModelOptions: strict validation admits image_no_upscale', (t) => {
  t.is(llmConfigBaseSchema.strict().safeParse({ image_no_upscale: 'on' }).success, true)
})

test('llmConfigBaseSchema: accepts mmproj-use-gpu boolean', (t) => {
  const enabled = llmConfigBaseSchema.safeParse({ 'mmproj-use-gpu': true })
  t.is(enabled.success, true)
  if (enabled.success) t.is(enabled.data['mmproj-use-gpu'], true)
  const disabled = llmConfigBaseSchema.safeParse({ 'mmproj-use-gpu': false })
  t.is(disabled.success, true)
  if (disabled.success) t.is(disabled.data['mmproj-use-gpu'], false)
})

test('llmConfigBaseSchema: rejects non-boolean mmproj-use-gpu', (t) => {
  t.is(llmConfigBaseSchema.safeParse({ 'mmproj-use-gpu': 'true' }).success, false)
  t.is(llmConfigBaseSchema.safeParse({ 'mmproj-use-gpu': 1 }).success, false)
})

test('llmConfigBaseSchema: mmproj-use-gpu is optional (auto-default when unset)', (t) => {
  const result = llmConfigBaseSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.absent('mmproj-use-gpu' in result.data)
})

test('llmConfigSchema: does not inject a default for mmproj-use-gpu', (t) => {
  const result = llmConfigSchema.safeParse({})
  t.is(result.success, true)
  if (result.success) t.absent('mmproj-use-gpu' in result.data)
})

test('loadModelOptionsToRequestSchema: accepts mmproj-use-gpu for LLM', (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { 'mmproj-use-gpu': true }
    }).success,
    true
  )
})
