import type { GgufFacts, KvLayerClass } from '@/schemas/model-resource-profile'
import type { ByteRange, EstimatorInput, EstimatorResult } from '@/resources/model-fit/types'

export const LLM_ESTIMATOR_VERSION = 'llm-v1'

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

/**
 * Estimates memory for a llama.cpp completion or embedding model from catalog
 * metadata alone.
 *
 * Weights come from the artifact size; the KV cache is computed from the
 * transformer shape and the requested context. The estimate is a range, not a
 * number, because two things are genuinely undetermined before load: the
 * backend the engine will pick (which sets the default KV-cache type) and, for
 * some architectures, which blocks hold a full cache.
 */
export function estimateLlm(input: EstimatorInput): EstimatorResult {
  const { profile, workload, calibration, extraArtifactBytes, hasGpu } = input

  if (workload.kind !== 'llm') {
    return {
      kind: 'unknown',
      estimatorVersion: LLM_ESTIMATOR_VERSION,
      reasons: [`workload kind '${workload.kind}' is not supported by ${LLM_ESTIMATOR_VERSION}`]
    }
  }

  const facts = profile.ggufFacts
  if (!facts) {
    return {
      kind: 'unknown',
      estimatorVersion: LLM_ESTIMATOR_VERSION,
      reasons: ['no GGUF metadata for this model in the catalog, so the KV cache cannot be sized']
    }
  }

  const assumptions: string[] = []
  const reasons: string[] = []

  // Weights: mapped at file size by default, so artifact bytes are the floor.
  // The upper coefficient covers the allocator's copy-on-write and alignment
  // slack measured during calibration.
  const artifactBytes = profile.artifactBytes + extraArtifactBytes
  assumptions.push(
    'weights are counted at full artifact size; llama.cpp maps them by default, so those pages are file-backed and evictable rather than anonymous RAM'
  )
  if (extraArtifactBytes > 0) {
    assumptions.push('companion artifacts passed in `artifacts` are counted at full size')
  }

  // Context: never more than the model was trained for — llama.cpp clamps.
  let contextTokens = workload.contextTokens
  if (contextTokens > facts.contextLength) {
    assumptions.push(
      `requested ${workload.contextTokens} tokens exceeds the trained context of ${facts.contextLength}; clamped to the trained context`
    )
    contextTokens = facts.contextLength
  }

  const element = kvElementBytes(facts, hasGpu)
  assumptions.push(element.assumption)
  const kv = kvCacheBytes(facts, contextTokens, element.bytes, assumptions, reasons)

  // Everything an LLM load costs is persistent, not a working peak: llama.cpp
  // builds the context when the model loads — KV cache, engine overhead and
  // the context-scaled compute buffers included — so every loaded model holds
  // all of it for its whole lifetime. Calibration runs confirmed this: the
  // RSS delta during a completion is ~0. Parking any of these terms in
  // `working` would let `sequential` aggregation count only the largest one
  // while all of them are resident.
  const persistent: ByteRange = {
    lower: Math.ceil(
      artifactBytes +
        kv.lower +
        calibration.fixedOverheadBytes.lower +
        calibration.computeBufferBytesPerToken.lower * contextTokens
    ),
    upper: Math.ceil(
      artifactBytes * calibration.weightUpperCoeff +
        kv.upper +
        calibration.fixedOverheadBytes.upper +
        calibration.computeBufferBytesPerToken.upper * contextTokens
    )
  }
  assumptions.push(
    'the KV cache, engine overhead and compute buffers count as resident for the model’s whole lifetime; llama.cpp allocates them when the model loads, not per operation'
  )

  assumptions.push(
    'default KV-cache types are assumed; an explicit `cache-type-k`/`cache-type-v` in `modelConfig` is not expressible in a workload and would change these numbers'
  )

  return {
    kind: 'estimate',
    estimatorVersion: LLM_ESTIMATOR_VERSION,
    persistent,
    working: { lower: 0, upper: 0 },
    reasons,
    assumptions
  }
}

/** A KV-cache element width range, with the reason it is that range. */
export interface KvElementWidth {
  bytes: ByteRange
  assumption: string
}

/**
 * Picks the KV-cache element width range for this model on this device.
 *
 * Exported because the calibration harness has to subtract the cache the engine
 * *actually* allocated before it can fit the remaining overhead. Hard-coding a
 * width there would skew the fit by roughly 2× on a GPU backend — and because
 * the error scales with context, it would corrupt the per-token slope rather
 * than shifting the intercept. Sharing this rule keeps the two in step.
 *
 * @returns Lower/upper bytes per cache element, and the assumption that choice
 *   rests on. Side-effect free so the harness can call it without an
 *   assumptions array.
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
 * Exported for the calibration harness, which must subtract the cache the
 * engine actually allocated using the exact accounting the estimator uses —
 * a hand-rolled copy drifted once already (no sliding-window branch, `ceil`
 * where the estimator bounds with `floor`, no SSM state). A non-degenerate
 * range means part of the layout is engine-owned, so the allocation cannot be
 * known from the file alone and the model is unsuitable for calibration; the
 * harness aborts on it rather than guessing.
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
