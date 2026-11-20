import { type LlmConfig } from '@/schemas/index'

const NATIVE_KEYS: Partial<Record<keyof LlmConfig, string>> = {
  ctxSize: 'ctx_size',
  temperature: 'temp',
  topP: 'top_p',
  topK: 'top_k',
  gpuLayers: 'gpu_layers',
  loadMode: 'load_mode',
  presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty',
  repeatPenalty: 'repeat_penalty',
  stopSequences: 'reverse_prompt',
  cacheCheckpoints: 'cache_checkpoints',
  cacheCheckpointsMaxBytes: 'cache_checkpoints_max_bytes',
  cacheCheckpointStorage: 'cache_checkpoint_storage',
  cacheCheckpointDir: 'cache_checkpoint_dir',
  cacheShareAcrossKeys: 'cache_share_across_keys',
  cacheRamMib: 'cache_ram_mib',
  cacheTypeK: 'cache-type-k',
  cacheTypeV: 'cache-type-v',
  mainGpu: 'main-gpu',
  rpcServers: 'rpc-servers',
  splitMode: 'split-mode',
  flashAttention: 'flash-attn',
  tensorSplit: 'tensor-split',
  batchSize: 'batch-size',
  ubatchSize: 'ubatch-size',
  cpuMoe: 'cpu-moe',
  nCpuMoe: 'n-cpu-moe',
  kvOffload: 'kv-offload',
  imageMaxTokens: 'image-max-tokens',
  imageMinTokens: 'image-min-tokens',
  imageMaxMegapixels: 'image-max-megapixels',
  pollBatch: 'poll-batch',
  threadsBatch: 'threads-batch',
  cpuMask: 'cpu-mask',
  cpuMaskBatch: 'cpu-mask-batch',
  overrideTensor: 'override-tensor',
  nCpuFfn: 'n-cpu-ffn',
  moeCacheMib: 'moe-cache-mib',
  prefetchWeights: 'prefetch-weights',
  tensorReadLazy: 'tensor-read-lazy',
  fitTarget: 'fit-target',
  fitCtx: 'fit-ctx',
  reasoningBudget: 'reasoning_budget',
  specType: 'spec_type',
  specDraftNMax: 'spec_draft_n_max',
  specDraftNMin: 'spec_draft_n_min',
  specDraftPMin: 'spec_draft_p_min',
  imageTileMode: 'image_tile_mode',
  imageNoUpscale: 'image_no_upscale',
  mmprojUseGpu: 'mmproj-use-gpu'
}

const JS_ONLY_KEYS = new Set(['modelType', 'systemPrompt'])

function toNativeValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Converts an LlmConfig into the flat string-keyed map the C++ addon expects. */
export function transformLlmConfig(llmConfig: LlmConfig) {
  const transformed: Record<string, string> = {}
  for (const [key, value] of Object.entries(llmConfig)) {
    if (value === undefined || JS_ONLY_KEYS.has(key)) continue
    transformed[NATIVE_KEYS[key as keyof LlmConfig] ?? key] = toNativeValue(value)
  }

  if ('cpu-moe' in transformed) {
    if (transformed['cpu-moe'] === 'true') {
      transformed['cpu-moe'] = ''
    } else {
      delete transformed['cpu-moe']
    }
  }

  if ('kv-offload' in transformed) {
    const enabled = transformed['kv-offload'] === 'true'
    delete transformed['kv-offload']
    transformed[enabled ? 'kv-offload' : 'no-kv-offload'] = ''
  }

  if (transformed['prefetch-weights'] === 'true') {
    transformed['prefetch-weights'] = '1'
  } else if (transformed['prefetch-weights'] === 'false') {
    transformed['prefetch-weights'] = '0'
  }

  return transformed
}
