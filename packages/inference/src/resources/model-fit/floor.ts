import type { ModelFitWorkload } from '@/schemas/assess-model-fit'
import type { ModelResourceProfile } from '@/schemas/model-resource-profile'
import { kvCacheBytesForWidth, kvElementBytes } from '@/resources/model-fit/estimators/llm'

export const FLOOR_VERSION = 'floor-v1'

/**
 * Engines whose load builds a KV cache the file sizes exactly, so the floor can
 * count it. Every other engine's working memory is engine-owned and unsized
 * here; the floor for those is the weights alone.
 */
const KV_CACHE_ENGINES: ReadonlySet<string> = new Set(['llamacpp-completion', 'llamacpp-embedding'])

export interface FloorInput {
  profile: ModelResourceProfile
  workload: ModelFitWorkload
  /** Artifact bytes of companion constants the caller passed alongside. */
  extraArtifactBytes: number
}

/** A lower bound with no upper bound, and how it was assembled. */
export interface FloorResult {
  bytes: number
  reasons: readonly string[]
  assumptions: readonly string[]
}

/**
 * The smallest resident footprint the catalog facts prove, with no coefficient
 * measured anywhere: artifact bytes, plus the KV cache for a llama.cpp model at
 * the cheapest element width the engine can default to.
 *
 * Every term a calibrated estimate adds on top — weight slack, engine overhead,
 * compute buffers, a completion's working peak — is non-negative, so a floor
 * with all of them at zero is unconditionally valid on any platform and any
 * backend. It can therefore refuse a model (`likely-too-large` when even the
 * floor is over budget) but never confirm one: how far above the floor the real
 * load lands is exactly what calibration exists to measure.
 *
 * This is the zero-fetch gate. It reads nothing but the catalog and stays the
 * fallback wherever no calibration or engine projection is available.
 */
export function computeFloor(input: FloorInput): FloorResult {
  const { profile, workload, extraArtifactBytes } = input

  const reasons: string[] = []
  const assumptions: string[] = [
    'weights are counted at full artifact size; whatever the engine maps or copies, the file has to be resident to run',
    'the floor omits engine overhead, compute buffers and working memory, all of which are non-negative, so it cannot overstate the cost — and says nothing about how much more the load needs'
  ]

  const artifactBytes = profile.artifactBytes + extraArtifactBytes
  if (extraArtifactBytes > 0) {
    assumptions.push('companion artifacts passed in `artifacts` are counted at full size')
  }

  if (!KV_CACHE_ENGINES.has(profile.engine)) {
    reasons.push(
      `the floor for engine '${profile.engine}' counts weights only; its working memory is engine-owned and not sized here`
    )
    return { bytes: artifactBytes, reasons, assumptions }
  }

  if (workload.kind !== 'llm') {
    reasons.push(
      `workload kind '${workload.kind}' carries no context for a llama.cpp model, so the floor counts weights only`
    )
    return { bytes: artifactBytes, reasons, assumptions }
  }

  const facts = profile.ggufFacts
  if (!facts) {
    reasons.push('no GGUF metadata for this model in the catalog, so the floor counts weights only')
    return { bytes: artifactBytes, reasons, assumptions }
  }

  let contextTokens = workload.contextTokens
  if (contextTokens > facts.contextLength) {
    assumptions.push(
      `requested ${workload.contextTokens} tokens exceeds the trained context of ${facts.contextLength}; clamped to the trained context`
    )
    contextTokens = facts.contextLength
  }

  // The narrowest default the engine can pick on any backend, so the floor
  // holds whether the model lands on a GPU (q8_0 with flash attention) or on
  // the CPU (f16). Architectures that disable flash attention stay f16 anyway.
  const element = kvElementBytes(facts, true).bytes.lower
  const kv = kvCacheBytesForWidth(facts, contextTokens, element).lower
  assumptions.push(
    element < 2
      ? 'the KV cache is floored at the q8_0 element width, the narrowest default the engine picks on any backend; a CPU load allocates an f16 cache above it'
      : `${facts.architecture} loads with flash attention off, so the KV cache is floored at f16 on every backend`,
    'default KV-cache types are assumed; an explicit `cache-type-k`/`cache-type-v` in `modelConfig` is not expressible in a workload and would change these numbers'
  )
  reasons.push(
    `KV cache floored for ${contextTokens} tokens at the narrowest default element width`
  )

  return { bytes: Math.ceil(artifactBytes + kv), reasons, assumptions }
}
