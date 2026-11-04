import type { GgufFacts, KvLayerClass } from '@/schemas/model-resource-profile'

/**
 * KV-cache element widths, in bytes per element.
 *
 * `f16` is the CPU default. On a Metal/Vulkan GPU backend with flash attention
 * on — the SDK's own defaults — `llm-llamacpp` defaults the cache to `q8_0`
 * instead (`addon/src/model-interface/LoadFitNormalization.cpp`, QVAC-21318).
 * `q8_0` packs 32 elements into a 34-byte block.
 */
const F16_BYTES_PER_ELEMENT = 2
const Q8_0_BYTES_PER_ELEMENT = 34 / 32

/** Recurrent/SSM state is kept in f32. */
const SSM_STATE_BYTES_PER_ELEMENT = 4

/**
 * Architectures that disable flash attention, so the GPU `q8_0` KV default
 * never applies and the cache stays `f16` on every backend.
 */
function disablesFlashAttention(architecture: string): boolean {
  return architecture.startsWith('bitnet')
}

// Shared with the computed floor so a mixed set carries one weights assumption, not two.
export const LLAMA_WEIGHTS_ASSUMPTION =
  'weights are counted at full artifact size; llama.cpp maps them by default, so those pages are file-backed and evictable rather than anonymous RAM'

/**
 * The narrowest KV-cache element width the engine can default to for this
 * model, in bytes: q8_0 where flash attention allows it, f16 otherwise.
 */
export function narrowestKvElementBytes(facts: GgufFacts): number {
  return disablesFlashAttention(facts.architecture) ? F16_BYTES_PER_ELEMENT : Q8_0_BYTES_PER_ELEMENT
}

/**
 * The smallest KV cache the requested context can need, at a fixed element
 * width and clamped to the trained context.
 *
 * Three cases, in order of how much the file actually tells us:
 *
 * 1. **Per-layer classes** — the file describes attention per block, so the
 *    cache is summed exactly, with sliding-window blocks capped at their window.
 * 2. **Hybrid attention/recurrent** — `full_attention_interval` says how many
 *    blocks hold a cache at all; the rest hold a fixed-size SSM state. Which
 *    blocks are which is engine-owned, so the fewest full blocks are counted.
 * 3. **Flat** — every block holds the same cache. A declared sliding window
 *    with no per-layer pattern is engine-owned, so every block is counted
 *    windowed.
 */
export function kvCacheFloorBytes(
  facts: GgufFacts,
  contextTokens: number,
  elementBytes: number
): number {
  const tokens = Math.min(contextTokens, facts.contextLength)

  if (facts.kvLayerClasses && facts.kvLayerClasses.length > 0) {
    return layerClassBytes(facts.kvLayerClasses, facts, tokens, elementBytes)
  }

  const perBlockPerToken = facts.headCountKv * (facts.keyLength + facts.valueLength)

  if (facts.fullAttentionInterval && facts.fullAttentionInterval > 1) {
    const fullBlocks = Math.floor(facts.blockCount / facts.fullAttentionInterval)
    const ssm = ssmStateBytes(facts, facts.blockCount - fullBlocks)
    return fullBlocks * perBlockPerToken * tokens * elementBytes + ssm
  }

  if (facts.slidingWindow) {
    const windowedTokens = Math.min(tokens, facts.slidingWindow)
    return facts.blockCount * perBlockPerToken * windowedTokens * elementBytes
  }

  return facts.blockCount * perBlockPerToken * tokens * elementBytes
}

function layerClassBytes(
  classes: readonly KvLayerClass[],
  facts: GgufFacts,
  contextTokens: number,
  elementBytes: number
): number {
  let total = 0
  for (const layerClass of classes) {
    const tokens =
      layerClass.windowed && facts.slidingWindow
        ? Math.min(contextTokens, facts.slidingWindow)
        : contextTokens
    total +=
      layerClass.count *
      layerClass.headCountKv *
      (layerClass.keyLength + layerClass.valueLength) *
      tokens *
      elementBytes
  }
  return total
}

/**
 * Fixed recurrent state for the blocks of a hybrid model that hold no KV cache:
 * the SSM state plus its convolution window, per block.
 */
function ssmStateBytes(facts: GgufFacts, recurrentBlocks: number): number {
  if (!facts.ssmInnerSize || !facts.ssmStateSize || recurrentBlocks <= 0) return 0
  const perBlock =
    facts.ssmInnerSize * facts.ssmStateSize + facts.ssmInnerSize * (facts.ssmConvKernel ?? 0)
  return recurrentBlocks * perBlock * SSM_STATE_BYTES_PER_ELEMENT
}
