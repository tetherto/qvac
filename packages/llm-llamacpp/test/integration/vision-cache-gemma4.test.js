'use strict'
// QVAC-19118 (A2): vision prefix cache integration tests for Gemma 4 E2B.
// Gemma 4 is the model the cache was benchmarked on (commit notes: ~48% TTFT
// reduction on a Mac M4 multi-turn same-image run). Split into its own file so
// each model loads in an isolated bare process — see _vision-cache-common.js.

const { runVisionCacheTests } = require('./_vision-cache-common.js')

// bartowski's GGUF tags <eos> as the EOG token, matching the base tokenizer so
// the generation loop terminates cleanly (see gemma4.test.js for the rationale).
const GEMMA4 = {
  label: 'Gemma 4 E2B',
  llmModel: {
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-google_gemma-4-E2B-it-bf16.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/mmproj-google_gemma-4-E2B-it-bf16.gguf'
  },
  // iOS-safe vision config copied verbatim from gemma4.test.js's image test:
  // ctx_size 4096 + ubatch-size 320 + reasoning-budget 0 keep the compute
  // buffer + KV cache under the iPhone Jetsam ceiling for a ~260-token image.
  visionConfig: {
    gpu_layers: '98',
    ctx_size: '4096',
    'ubatch-size': '320',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2'
  },
  // E2B embeddings: ~260 image tokens x 2048 dims x 4 bytes ≈ 2.1 MB/entry, so
  // a 3 MB budget holds one image but not two → the second distinct image
  // forces an LRU eviction.
  evictBudgetMb: '3'
}

runVisionCacheTests(GEMMA4)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
