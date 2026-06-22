'use strict'
// QVAC-19118 (A2): vision prefix cache integration tests for Qwen3.5-0.8B.
// Qwen's VLM uses M-RoPE, so the cached embedding's nPos differs from nTokens —
// this exercises the VisionCacheEntry nPos path that Gemma's standard RoPE does
// not. Split into its own file so each model loads in an isolated bare process —
// see _vision-cache-common.js.

const { runVisionCacheTests } = require('./_vision-cache-common.js')

const QWEN3_5 = {
  label: 'Qwen3.5-0.8B',
  llmModel: {
    modelName: 'Qwen3.5-0.8B-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
  },
  projModel: {
    modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
  },
  // Vision config aligned with Gemma 4 E2B's known-good Vulkan config.
  // QVAC-19118 (A2): on the Vulkan legs (linux-x64-gpu, win32) Qwen3.5 crashed
  // the backend with "[MtmdLlm] failed to decode next token" on the SECOND
  // distinct image of the vision-cache suite, aborting the whole process —
  // while the CPU and iOS/Metal legs passed the same sequence. Gemma 4, which
  // sets ubatch-size + reasoning-budget, decodes cleanly on those same Vulkan
  // legs. Mirror that config for Qwen (M-RoPE): cap the prefill micro-batch
  // (ubatch-size) and disable the reasoning path (reasoning-budget 0) so the
  // Vulkan M-RoPE decode stays on the path Gemma already exercises safely.
  // Backend-specific (not reproducible on the CPU-only dev box) — confirm on a
  // GPU CI run.
  visionConfig: {
    gpu_layers: '98',
    ctx_size: '4096',
    'ubatch-size': '320',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2'
  },
  // 0.8B embeddings are smaller (~1 MB for the 612x408 elephant, less for the
  // 500x350 newspaper), so a 1 MB budget holds one image but not two → the
  // second distinct image forces an LRU eviction. (The budget test degrades
  // gracefully if the exact sizes differ, so this only needs to be roughly
  // one entry.)
  evictBudgetMb: '1'
}

runVisionCacheTests(QWEN3_5)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
