import test from 'brittle'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { toNativeGenerationParams } from '@/plugins/builtin/llamacpp-completion/generation-params'
import { llmConfigSchema } from '@/schemas/llamacpp-config'

function makeConfig(overrides: Record<string, unknown> = {}) {
  return llmConfigSchema.parse(overrides)
}

test('transformLlmConfig: every key reaches the addon under its native name', (t) => {
  const result = transformLlmConfig(
    makeConfig({
      backend: ['cuda', 'vulkan'],
      ctxSize: 4096,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      seed: 7,
      gpuLayers: 20,
      lora: '/m/lora.gguf',
      device: 'gpu',
      predict: 256,
      systemPrompt: 'be brief',
      loadMode: 'mmap',
      verbosity: 2,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      repeatPenalty: 1.1,
      stopSequences: ['</s>', 'END'],
      parallel: 2,
      tools: true,
      cacheCheckpoints: 3,
      cacheCheckpointsMaxBytes: 1048576,
      cacheCheckpointStorage: 'disk',
      cacheCheckpointDir: '/tmp/ckpt',
      cacheShareAcrossKeys: false,
      cacheRamMib: 512,
      cacheTypeK: 'q8_0',
      cacheTypeV: 'q8_0',
      mainGpu: 1,
      rpcServers: '10.0.0.1:50052',
      devices: 'RPC0,RPC1',
      splitMode: 'layer',
      flashAttention: 'on',
      tensorSplit: '3,1',
      batchSize: 1024,
      ubatchSize: 256,
      cpuMoe: true,
      nCpuMoe: 4,
      kvOffload: true,
      imageMaxTokens: 1024,
      imageMinTokens: 64,
      imageMaxMegapixels: 12,
      poll: 50,
      pollBatch: 25,
      threads: 8,
      threadsBatch: 4,
      cpuMask: 'ff',
      cpuMaskBatch: 'f0',
      overrideTensor: 'blk\\.1\\.ffn_up_exps=CPU',
      nCpuFfn: 2,
      moeCacheMib: 'auto',
      prefetchWeights: true,
      tensorReadLazy: 'auto',
      fit: true,
      fitTarget: '1024,512',
      fitCtx: 4096,
      openclCacheDir: '/data/cache',
      reasoningBudget: 128,
      specType: 'draft-mtp',
      specDraftNMax: 4,
      specDraftNMin: 1,
      specDraftPMin: 0.5,
      imageTileMode: 'batched',
      imageNoUpscale: 'on',
      mmprojUseGpu: false
    })
  )

  t.alike(result, {
    backend: 'cuda, vulkan',
    ctx_size: '4096',
    temp: '0.7',
    top_p: '0.9',
    top_k: '40',
    seed: '7',
    gpu_layers: '20',
    lora: '/m/lora.gguf',
    device: 'gpu',
    predict: '256',
    load_mode: 'mmap',
    verbosity: '2',
    presence_penalty: '0.1',
    frequency_penalty: '0.2',
    repeat_penalty: '1.1',
    parallel: '2',
    tools: 'true',
    cache_checkpoints: '3',
    cache_checkpoints_max_bytes: '1048576',
    cache_checkpoint_storage: 'disk',
    cache_checkpoint_dir: '/tmp/ckpt',
    cache_share_across_keys: 'false',
    cache_ram_mib: '512',
    'cache-type-k': 'q8_0',
    'cache-type-v': 'q8_0',
    'main-gpu': '1',
    'rpc-servers': '10.0.0.1:50052',
    devices: 'RPC0,RPC1',
    'split-mode': 'layer',
    'flash-attn': 'on',
    'tensor-split': '3,1',
    'batch-size': '1024',
    'ubatch-size': '256',
    'cpu-moe': '',
    'n-cpu-moe': '4',
    'image-max-tokens': '1024',
    'image-min-tokens': '64',
    'image-max-megapixels': '12',
    poll: '50',
    threads: '8',
    'threads-batch': '4',
    'cpu-mask': 'ff',
    'cpu-mask-batch': 'f0',
    'override-tensor': 'blk\\.1\\.ffn_up_exps=CPU',
    'n-cpu-ffn': '2',
    'moe-cache-mib': 'auto',
    'prefetch-weights': '1',
    'tensor-read-lazy': 'auto',
    fit: 'true',
    'fit-target': '1024,512',
    'fit-ctx': '4096',
    reasoning_budget: '128',
    spec_type: 'draft-mtp',
    spec_draft_n_max: '4',
    spec_draft_n_min: '1',
    spec_draft_p_min: '0.5',
    image_tile_mode: 'batched',
    image_no_upscale: 'on',
    'mmproj-use-gpu': 'false',
    'poll-batch': '25',
    reverse_prompt: '</s>, END',
    openclCacheDir: '/data/cache',
    'kv-offload': ''
  })
})

test('transformLlmConfig: systemPrompt and modelType are never forwarded to C++', (t) => {
  const result = transformLlmConfig(makeConfig({ systemPrompt: 'You are a helpful assistant.' }))
  t.absent('systemPrompt' in result)
  t.absent('system_prompt' in result)
  t.absent('modelType' in result)
})

test('transformLlmConfig: reasoningBudget reaches the addon as a string', (t) => {
  for (const budget of [-1, 0, 128]) {
    t.is(
      transformLlmConfig(makeConfig({ reasoningBudget: budget }))['reasoning_budget'],
      `${budget}`
    )
  }
})

test('transformLlmConfig: cpuMoe becomes a valueless flag, or is dropped', (t) => {
  t.is(transformLlmConfig(makeConfig({ cpuMoe: true }))['cpu-moe'], '')
  t.absent('cpu-moe' in transformLlmConfig(makeConfig({ cpuMoe: false })))
})

test('transformLlmConfig: kvOffload picks the spelling that carries its polarity', (t) => {
  const enabled = transformLlmConfig(makeConfig({ kvOffload: true }))
  t.is(enabled['kv-offload'], '')
  t.absent('no-kv-offload' in enabled)

  const disabled = transformLlmConfig(makeConfig({ kvOffload: false }))
  t.is(disabled['no-kv-offload'], '')
  t.absent('kv-offload' in disabled)
})

test('transformLlmConfig: prefetchWeights is forwarded as 0, 1 or auto', (t) => {
  t.is(transformLlmConfig(makeConfig({ prefetchWeights: true }))['prefetch-weights'], '1')
  t.is(transformLlmConfig(makeConfig({ prefetchWeights: false }))['prefetch-weights'], '0')
  t.is(transformLlmConfig(makeConfig({ prefetchWeights: 'auto' }))['prefetch-weights'], 'auto')
})

test('transformLlmConfig: moeCacheMib and fitTarget take their string forms', (t) => {
  t.is(transformLlmConfig(makeConfig({ moeCacheMib: 2048 }))['moe-cache-mib'], '2048')
  t.is(transformLlmConfig(makeConfig({ fitTarget: 512 }))['fit-target'], '512')
})

test('toNativeGenerationParams: every key reaches the addon under its native name', (t) => {
  t.alike(
    toNativeGenerationParams({
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      predict: 64,
      seed: 3,
      frequencyPenalty: 0.1,
      presencePenalty: 0.3,
      repeatPenalty: 1.2,
      reasoningBudget: 0,
      toolChoice: 'required',
      parallelToolCalls: false
    }),
    {
      temp: 0.2,
      top_p: 0.8,
      top_k: 20,
      predict: 64,
      seed: 3,
      frequency_penalty: 0.1,
      presence_penalty: 0.3,
      repeat_penalty: 1.2,
      reasoning_budget: 0,
      tool_choice: 'required',
      parallel_tool_calls: false
    }
  )
})

test('toNativeGenerationParams: parallel tool calls default to true', (t) => {
  t.alike(toNativeGenerationParams(undefined), { parallel_tool_calls: true })
})

test('toNativeGenerationParams: a JSON-schema response format becomes json_schema', (t) => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  t.alike(
    toNativeGenerationParams(
      { seed: 1 },
      { type: 'json_schema', jsonSchema: { name: 'A', schema } }
    ),
    { seed: 1, json_schema: JSON.stringify(schema), parallel_tool_calls: true }
  )
  t.alike(toNativeGenerationParams(undefined, { type: 'text' }), { parallel_tool_calls: true })
})
