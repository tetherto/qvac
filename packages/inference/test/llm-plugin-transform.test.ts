import test from 'brittle'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { llmConfigSchema } from '@/schemas/llamacpp-config'

function makeConfig(overrides: Record<string, unknown> = {}) {
  return llmConfigSchema.parse(overrides)
}

test('transformLlmConfig: system_prompt is never forwarded to C++', (t) => {
  const config = makeConfig({ system_prompt: 'You are a helpful assistant.' })
  const result = transformLlmConfig(config)
  t.absent('system_prompt' in result, 'system_prompt must not appear in C++ arg map')
  t.absent('system-prompt' in result, 'hyphenated system-prompt must not appear in C++ arg map')
})

test('transformLlmConfig: modelType is never forwarded to C++', (t) => {
  const config = makeConfig({})
  const result = transformLlmConfig(config)
  t.absent('modelType' in result, 'modelType must not appear in C++ arg map')
  t.absent('model_type' in result)
})

test('transformLlmConfig: reasoning_budget survives as underscore key', (t) => {
  const config = makeConfig({ reasoning_budget: 0 })
  const result = transformLlmConfig(config)
  t.is(result['reasoning_budget'], '0', "reasoning_budget=0 must be forwarded as string '0'")
})

test('transformLlmConfig: reasoning_budget=-1 survives', (t) => {
  const config = makeConfig({ reasoning_budget: -1 })
  const result = transformLlmConfig(config)
  t.is(result['reasoning_budget'], '-1')
})

test('transformLlmConfig: positive reasoning_budget survives as string token cap', (t) => {
  const config = makeConfig({ reasoning_budget: 128 })
  const result = transformLlmConfig(config)
  t.is(
    result['reasoning_budget'],
    '128',
    "positive reasoning_budget must be forwarded as string '128'"
  )
})

test('transformLlmConfig: load_mode survives as an underscore key', (t) => {
  const config = makeConfig({ load_mode: 'mmap+mlock' })
  const result = transformLlmConfig(config)
  t.is(result['load_mode'], 'mmap+mlock')
  t.absent('load-mode' in result)
})

test('transformLlmConfig: stop_sequences is renamed to reverse_prompt', (t) => {
  const config = makeConfig({ stop_sequences: ['</s>', '<|im_end|>'] })
  const result = transformLlmConfig(config)
  t.absent('stop_sequences' in result)
  t.is(result['reverse_prompt'], '</s>, <|im_end|>')
})

test('transformLlmConfig: numeric fields are stringified', (t) => {
  const config = makeConfig({ ctx_size: 4096, gpu_layers: 99, temp: 0.7 })
  const result = transformLlmConfig(config)
  t.is(result['ctx_size'], '4096')
  t.is(result['gpu_layers'], '99')
  t.is(result['temp'], '0.7')
})

test('transformLlmConfig: parallel is forwarded as a string', (t) => {
  const config = makeConfig({ parallel: 4 })
  const result = transformLlmConfig(config)
  t.is(result['parallel'], '4')
})

test('transformLlmConfig: cpu-moe becomes a valueless flag, or is dropped', (t) => {
  t.is(transformLlmConfig(makeConfig({ 'cpu-moe': true }))['cpu-moe'], '')
  t.absent('cpu-moe' in transformLlmConfig(makeConfig({ 'cpu-moe': false })))
})

test('transformLlmConfig: kv-offload picks the spelling that carries its polarity', (t) => {
  const enabled = transformLlmConfig(makeConfig({ 'kv-offload': true }))
  t.is(enabled['kv-offload'], '')
  t.absent('no-kv-offload' in enabled)

  const disabled = transformLlmConfig(makeConfig({ 'kv-offload': false }))
  t.is(disabled['no-kv-offload'], '')
  t.absent('kv-offload' in disabled)
})

test('transformLlmConfig: prefetch-weights is forwarded as 0, 1 or auto', (t) => {
  t.is(transformLlmConfig(makeConfig({ 'prefetch-weights': true }))['prefetch-weights'], '1')
  t.is(transformLlmConfig(makeConfig({ 'prefetch-weights': false }))['prefetch-weights'], '0')
  t.is(transformLlmConfig(makeConfig({ 'prefetch-weights': 'auto' }))['prefetch-weights'], 'auto')
})

test('transformLlmConfig: placement and fit keys keep their kebab spelling', (t) => {
  const result = transformLlmConfig(
    makeConfig({
      threads: 8,
      'threads-batch': 16,
      'cpu-mask': 'ff',
      'cpu-mask-batch': 'f0',
      'override-tensor': 'blk\\.(1[0-9])\\.ffn_(up|down|gate)_exps=CPU',
      'n-cpu-ffn': 4,
      'moe-cache-mib': 2048,
      'tensor-read-lazy': 'on',
      fit: true,
      'fit-target': '1024,512',
      'fit-ctx': 8192
    })
  )

  t.is(result['threads'], '8')
  t.is(result['threads-batch'], '16')
  t.is(result['cpu-mask'], 'ff')
  t.is(result['cpu-mask-batch'], 'f0')
  t.is(result['override-tensor'], 'blk\\.(1[0-9])\\.ffn_(up|down|gate)_exps=CPU')
  t.is(result['n-cpu-ffn'], '4')
  t.is(result['moe-cache-mib'], '2048')
  t.is(result['tensor-read-lazy'], 'on')
  t.is(result['fit'], 'true')
  t.is(result['fit-target'], '1024,512')
  t.is(result['fit-ctx'], '8192')
})

test('transformLlmConfig: moe-cache-mib and fit-target take their string forms', (t) => {
  t.is(transformLlmConfig(makeConfig({ 'moe-cache-mib': 'auto' }))['moe-cache-mib'], 'auto')
  t.is(transformLlmConfig(makeConfig({ 'fit-target': 512 }))['fit-target'], '512')
})
