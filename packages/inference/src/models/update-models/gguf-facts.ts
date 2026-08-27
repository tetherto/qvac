import type { GgufFacts, KvLayerClass } from './types'

/**
 * Raw GGUF key-value metadata as the registry stores it: the parsed JSON of
 * `QVACModelEntry.ggufMetadata`. Values arrive as numbers, booleans, strings
 * (BigInts are stringified at ingest), or arrays of those.
 */
type GgufMetadata = Record<string, unknown>

/**
 * Parses the registry's `ggufMetadata` JSON string.
 *
 * @param raw - The JSON string from the registry entry, or `undefined` when the
 *   entry carries no GGUF metadata (non-GGUF artifact, or extraction failed).
 * @returns The parsed key-value map, or `null` when absent or unparseable.
 */
export function parseGgufMetadata(raw: string | undefined): GgufMetadata | null {
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as GgufMetadata
  } catch {
    return null
  }
}

/**
 * Derives the transformer facts the resource estimators need from raw GGUF
 * key-value metadata.
 *
 * Only the architecture-independent shape is extracted: everything needed to
 * size a KV cache plus the trained context window. Architecture-specific keys
 * that change how the cache is allocated (sliding window, hybrid attention
 * interval, SSM state) are carried through when present so estimators can
 * either account for them or decline to guess.
 *
 * @param metadata - Parsed GGUF key-value metadata.
 * @returns The extracted facts, or `null` when a required key is missing (the
 *   entry then has no `ggufFacts` and estimators treat it as unknown).
 */
export function extractGgufFacts(metadata: GgufMetadata | null): GgufFacts | null {
  if (!metadata) return null

  const architecture = readString(metadata['general.architecture'])
  if (!architecture) return null

  const assumptions: string[] = []

  const blockCount = readNumber(metadata[`${architecture}.block_count`])
  const embeddingLength = readNumber(metadata[`${architecture}.embedding_length`])
  const contextLength = readNumber(metadata[`${architecture}.context_length`])
  const headCount = readMaxNumber(metadata[`${architecture}.attention.head_count`])

  if (!blockCount || !embeddingLength || !contextLength || !headCount) return null

  // Multi-head architectures (e.g. bert) omit `head_count_kv` entirely; there
  // grouped-query attention degenerates to one KV head per attention head.
  // Hybrid GQA models may store one value per layer — the largest is the
  // conservative choice for a memory bound.
  const rawHeadCountKv = metadata[`${architecture}.attention.head_count_kv`]
  let headCountKv = readMaxNumber(rawHeadCountKv)
  if (!headCountKv) {
    headCountKv = headCount
    assumptions.push('head_count_kv absent — assumed equal to head_count (no GQA)')
  } else if (Array.isArray(rawHeadCountKv) && rawHeadCountKv.length > 1) {
    assumptions.push('head_count_kv is per-layer — used the maximum')
  }

  // `key_length`/`value_length` are optional; llama.cpp falls back to the
  // per-head embedding width when they are absent.
  const perHead = Math.floor(embeddingLength / headCount)
  let keyLength = readNumber(metadata[`${architecture}.attention.key_length`])
  let valueLength = readNumber(metadata[`${architecture}.attention.value_length`])
  if (!keyLength || !valueLength) {
    keyLength = keyLength || perHead
    valueLength = valueLength || perHead
    assumptions.push('key_length/value_length absent — derived from embedding_length / head_count')
  }

  const facts: GgufFacts = {
    architecture,
    blockCount,
    headCount,
    headCountKv,
    keyLength,
    valueLength,
    embeddingLength,
    contextLength
  }

  const parameterCount = readNumber(metadata['general.parameter_count'])
  if (parameterCount) facts.parameterCount = parameterCount

  // Sliding-window attention: the SWA layers hold a cache truncated to the
  // window, and often at narrower key/value widths.
  const slidingWindow = readNumber(metadata[`${architecture}.attention.sliding_window`])
  if (slidingWindow) facts.slidingWindow = slidingWindow

  const keyLengthSwa = readNumber(metadata[`${architecture}.attention.key_length_swa`])
  if (keyLengthSwa) facts.keyLengthSwa = keyLengthSwa

  const valueLengthSwa = readNumber(metadata[`${architecture}.attention.value_length_swa`])
  if (valueLengthSwa) facts.valueLengthSwa = valueLengthSwa

  // When the file describes attention per layer, the flat scalars above are
  // only an upper bound. Collapse the per-layer detail into layer classes so an
  // estimator can sum the real cache instead of assuming every layer is the
  // widest one.
  const layerClasses = deriveKvLayerClasses(metadata, architecture, {
    blockCount,
    headCountKvFallback: headCountKv,
    keyLength,
    valueLength,
    keyLengthSwa,
    valueLengthSwa
  })
  if (layerClasses) {
    facts.kvLayerClasses = layerClasses
    assumptions.push('kvLayerClasses derived from per-layer attention metadata')
  }

  // Hybrid attention/recurrent models (e.g. qwen35) keep full attention only
  // every Nth block; the rest hold a fixed-size SSM state instead.
  const fullAttentionInterval = readNumber(metadata[`${architecture}.full_attention_interval`])
  if (fullAttentionInterval) facts.fullAttentionInterval = fullAttentionInterval

  const ssmStateSize = readNumber(metadata[`${architecture}.ssm.state_size`])
  if (ssmStateSize) facts.ssmStateSize = ssmStateSize

  const ssmConvKernel = readNumber(metadata[`${architecture}.ssm.conv_kernel`])
  if (ssmConvKernel) facts.ssmConvKernel = ssmConvKernel

  const ssmInnerSize = readNumber(metadata[`${architecture}.ssm.inner_size`])
  if (ssmInnerSize) facts.ssmInnerSize = ssmInnerSize

  const ssmGroupCount = readNumber(metadata[`${architecture}.ssm.group_count`])
  if (ssmGroupCount) facts.ssmGroupCount = ssmGroupCount

  if (assumptions.length > 0) facts.assumptions = assumptions

  return facts
}

interface LayerClassInputs {
  blockCount: number
  headCountKvFallback: number
  keyLength: number
  valueLength: number
  keyLengthSwa: number | undefined
  valueLengthSwa: number | undefined
}

/**
 * Collapses per-layer attention metadata into distinct layer classes.
 *
 * Models like `gemma4` store `attention.head_count_kv` and
 * `attention.sliding_window_pattern` as one entry per block, which is the only
 * place the real KV-cache shape is recorded. Grouping identical layers keeps the
 * generated catalog small while staying exact.
 *
 * @returns The layer classes in first-appearance order, or `undefined` when the
 *   file has no per-layer detail (the flat scalars already describe every layer)
 *   or an array's length disagrees with `block_count`.
 */
function deriveKvLayerClasses(
  metadata: GgufMetadata,
  architecture: string,
  inputs: LayerClassInputs
): KvLayerClass[] | undefined {
  const rawHeadCountKv = metadata[`${architecture}.attention.head_count_kv`]
  const rawSwaPattern = metadata[`${architecture}.attention.sliding_window_pattern`]

  const headCountKvPerLayer = Array.isArray(rawHeadCountKv) ? rawHeadCountKv : undefined
  const swaPattern = Array.isArray(rawSwaPattern) ? rawSwaPattern : undefined

  if (!headCountKvPerLayer && !swaPattern) return undefined
  if (headCountKvPerLayer && headCountKvPerLayer.length !== inputs.blockCount) return undefined
  if (swaPattern && swaPattern.length !== inputs.blockCount) return undefined

  const classes: KvLayerClass[] = []

  for (let layer = 0; layer < inputs.blockCount; layer++) {
    const windowed = swaPattern ? swaPattern[layer] === true : false
    const headCountKv = headCountKvPerLayer
      ? (readNumber(headCountKvPerLayer[layer]) ?? inputs.headCountKvFallback)
      : inputs.headCountKvFallback
    const keyLength = (windowed ? inputs.keyLengthSwa : undefined) ?? inputs.keyLength
    const valueLength = (windowed ? inputs.valueLengthSwa : undefined) ?? inputs.valueLength

    const existing = classes.find(
      (candidate) =>
        candidate.windowed === windowed &&
        candidate.headCountKv === headCountKv &&
        candidate.keyLength === keyLength &&
        candidate.valueLength === valueLength
    )

    if (existing) {
      existing.count++
    } else {
      classes.push({ count: 1, headCountKv, keyLength, valueLength, windowed })
    }
  }

  return classes
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Reads a GGUF numeric value. Ingest stringifies BigInts, so a string that
 * parses as a finite number is accepted.
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Reads a scalar or per-layer array, taking the largest entry of an array. */
function readMaxNumber(value: unknown): number | undefined {
  if (!Array.isArray(value)) return readNumber(value)

  let max: number | undefined
  for (const entry of value) {
    const parsed = readNumber(entry)
    if (parsed === undefined) continue
    if (max === undefined || parsed > max) max = parsed
  }
  return max
}
