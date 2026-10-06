import type { GgufFacts, KvLayerClass } from '@/schemas/model-resource-profile'
import type { ByteRange } from '@/resources/model-fit/types'

/**
 * KV-cache element widths, in bytes per element.
 *
 * `f16` is the CPU default. On a Metal/Vulkan GPU backend with flash attention
 * on — the SDK's own defaults — `llm-llamacpp` defaults the cache to `q8_0`
 * instead (`addon/src/model-interface/LoadFitNormalization.cpp`, QVAC-21318),
 * which is why the bound is a range rather than a number. `q8_0` packs 32
 * elements into a 34-byte block.
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

/** A KV-cache element width range, with the reason it is that range. */
export interface KvElementWidth {
  bytes: ByteRange
  assumption: string
}

/**
 * Picks the KV-cache element width range for this model on this device.
 *
 * @returns Lower/upper bytes per cache element, and the assumption that choice
 *   rests on.
 */
export function kvElementBytes(facts: GgufFacts, hasGpu: boolean): KvElementWidth {
  if (disablesFlashAttention(facts.architecture)) {
    return {
      bytes: { lower: F16_BYTES_PER_ELEMENT, upper: F16_BYTES_PER_ELEMENT },
      assumption: `${facts.architecture} loads with flash attention off, so the KV cache stays f16 on every backend`
    }
  }

  if (hasGpu) {
    return {
      bytes: { lower: Q8_0_BYTES_PER_ELEMENT, upper: F16_BYTES_PER_ELEMENT },
      assumption:
        'a GPU is present, so the engine may default the KV cache to q8_0 (lower bound) or keep f16 on a CPU or OpenCL backend (upper bound)'
    }
  }

  return {
    bytes: { lower: F16_BYTES_PER_ELEMENT, upper: F16_BYTES_PER_ELEMENT },
    assumption: 'no GPU reported, so the CPU f16 KV-cache default applies'
  }
}

/**
 * KV-cache bytes at one fixed element width, clamped to the trained context.
 *
 * A non-degenerate range means part of the layout is engine-owned, so the
 * allocation cannot be known from the file alone.
 */
export function kvCacheBytesForWidth(
  facts: GgufFacts,
  contextTokens: number,
  bytesPerElement: number
): ByteRange {
  const tokens = Math.min(contextTokens, facts.contextLength)
  return kvCacheBytes(facts, tokens, { lower: bytesPerElement, upper: bytesPerElement }, [], [])
}

/**
 * Sizes the KV cache for the requested context.
 *
 * Three cases, in order of how much the file actually tells us:
 *
 * 1. **Per-layer classes** — the file describes attention per block, so the
 *    cache is summed exactly, with sliding-window blocks capped at their window.
 * 2. **Hybrid attention/recurrent** — `full_attention_interval` says how many
 *    blocks hold a cache at all; the rest hold a fixed-size SSM state. Which
 *    blocks are which is engine-owned, so the count is bounded, not fixed.
 * 3. **Flat** — every block holds the same cache. When the file declares a
 *    sliding window but no per-layer pattern, the pattern lives in the engine:
 *    the bound then spans "every block windowed" to "every block full", which is
 *    wide on purpose.
 */
function kvCacheBytes(
  facts: GgufFacts,
  contextTokens: number,
  elementBytes: ByteRange,
  assumptions: string[],
  reasons: string[]
): ByteRange {
  if (facts.kvLayerClasses && facts.kvLayerClasses.length > 0) {
    reasons.push('KV cache summed per layer class from the file’s per-block attention metadata')
    return {
      lower: layerClassBytes(facts.kvLayerClasses, facts, contextTokens, elementBytes.lower),
      upper: layerClassBytes(facts.kvLayerClasses, facts, contextTokens, elementBytes.upper)
    }
  }

  const perBlockPerToken = facts.headCountKv * (facts.keyLength + facts.valueLength)

  if (facts.fullAttentionInterval && facts.fullAttentionInterval > 1) {
    const interval = facts.fullAttentionInterval
    const fullBlocksLower = Math.floor(facts.blockCount / interval)
    const fullBlocksUpper = Math.ceil(facts.blockCount / interval)
    const ssm = ssmStateBytes(facts, facts.blockCount - fullBlocksLower)

    assumptions.push(
      `${facts.architecture} keeps full attention every ${interval} blocks; the remaining blocks hold a fixed-size recurrent state instead of a KV cache, and which blocks are which is engine-owned`
    )
    reasons.push(
      `KV cache sized for ${fullBlocksLower}–${fullBlocksUpper} of ${facts.blockCount} blocks (hybrid attention)`
    )

    return {
      lower: fullBlocksLower * perBlockPerToken * contextTokens * elementBytes.lower + ssm,
      upper: fullBlocksUpper * perBlockPerToken * contextTokens * elementBytes.upper + ssm
    }
  }

  if (facts.slidingWindow) {
    const windowedTokens = Math.min(contextTokens, facts.slidingWindow)
    assumptions.push(
      `${facts.architecture} uses sliding-window attention with a ${facts.slidingWindow}-token window, but the file does not say which blocks are windowed; the bound spans every block windowed to every block full`
    )
    reasons.push('sliding-window layer pattern is engine-owned, so the KV bound is wide')
    return {
      lower: facts.blockCount * perBlockPerToken * windowedTokens * elementBytes.lower,
      upper: facts.blockCount * perBlockPerToken * contextTokens * elementBytes.upper
    }
  }

  reasons.push(`KV cache sized for all ${facts.blockCount} blocks at ${contextTokens} tokens`)
  return {
    lower: facts.blockCount * perBlockPerToken * contextTokens * elementBytes.lower,
    upper: facts.blockCount * perBlockPerToken * contextTokens * elementBytes.upper
  }
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
