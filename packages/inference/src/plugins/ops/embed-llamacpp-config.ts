const NATIVE_KEYS: Readonly<Record<string, string>> = {
  gpuLayers: 'gpu_layers',
  batchSize: 'batch_size',
  pollBatch: 'poll-batch',
  threadsBatch: 'threads-batch',
  flashAttention: 'flash_attn',
  mainGpu: 'main-gpu',
  splitMode: 'split-mode',
  tensorSplit: 'tensor-split'
}

export function toNativeEmbedLlamacppConfig(config: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        NATIVE_KEYS[key] ?? key,
        Array.isArray(value) ? value.join(',') : String(value)
      ])
  )
}
