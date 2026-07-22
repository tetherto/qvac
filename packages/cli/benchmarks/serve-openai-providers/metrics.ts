import type {
  AggregateStats,
  MetricObservation,
  RunMetrics,
  StreamParseResult,
  ValidateRunParams,
  ValidationResult
} from './types'

export const THINK_MARKERS = ['<think>', '</think>'] as const

export function isTokenCount(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

export function computeMetrics(parsed: StreamParseResult): RunMetrics {
  const timings = parsed.timings
  const ttftMs =
    timings.firstContentS === null ? null : (timings.firstContentS - timings.requestStartS) * 1000
  const totalMs =
    timings.streamEndS === null ? null : (timings.streamEndS - timings.requestStartS) * 1000
  const clientOutputTps =
    isTokenCount(parsed.completionTokens) &&
    parsed.completionTokens > 0 &&
    totalMs !== null &&
    totalMs > 0
      ? parsed.completionTokens / (totalMs / 1000)
      : null
  const effectivePrefillTps =
    isTokenCount(parsed.promptTokens) && parsed.promptTokens > 0 && ttftMs !== null && ttftMs > 0
      ? parsed.promptTokens / (ttftMs / 1000)
      : null

  return {
    ttftMs,
    totalMs,
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    clientOutputTps,
    effectivePrefillTps
  }
}

export function validateRun(params: ValidateRunParams): ValidationResult {
  const requireContent = params.requireContent ?? true
  const checkReasoningOff = params.checkReasoningOff ?? true
  const reasons: string[] = []
  const { parsed, metrics } = params

  if (parsed.error) {
    reasons.push(`stream_error:${parsed.error}`)
  }
  if (requireContent && !parsed.content.trim()) {
    reasons.push('empty_content')
  }
  if (parsed.promptTokens === null || parsed.completionTokens === null) {
    reasons.push('missing_usage')
  }
  if (parsed.promptTokens !== null && !isTokenCount(parsed.promptTokens)) {
    reasons.push('invalid_prompt_tokens')
  } else if (parsed.promptTokens === 0) {
    reasons.push('prompt_tokens_zero')
  }
  if (parsed.completionTokens !== null && !isTokenCount(parsed.completionTokens)) {
    reasons.push('invalid_completion_tokens')
  } else if (parsed.completionTokens === 0) {
    reasons.push('completion_tokens_zero')
  }
  if (metrics.ttftMs === null) {
    reasons.push('missing_ttft')
  }
  if (metrics.totalMs === null) {
    reasons.push('missing_total')
  }
  if (checkReasoningOff) {
    const lowered = parsed.content.toLowerCase()
    for (const marker of THINK_MARKERS) {
      if (lowered.includes(marker)) {
        reasons.push(`think_marker_in_content:${marker}`)
        break
      }
    }
    if (parsed.reasoningContent.trim()) {
      reasons.push('reasoning_content_non_empty')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

export function quantilesInclusive(values: number[]): [number, number, number] {
  if (values.length === 0) {
    throw new Error('values must be non-empty')
  }
  if (values.length === 1) {
    const value = values[0]!
    return [value, value, value]
  }
  const data = [...values].sort((a, b) => a - b)
  const quartileCount = 4
  const range = data.length - 1
  const result: number[] = []
  for (let index = 1; index < quartileCount; index += 1) {
    const product = index * range
    const lowerIndex = Math.floor(product / quartileCount)
    const remainder = product % quartileCount
    const lower = data[lowerIndex]!
    const upper = data[lowerIndex + 1]!
    result.push((lower * (quartileCount - remainder) + upper * remainder) / quartileCount)
  }
  return [result[0]!, result[1]!, result[2]!]
}

export function aggregateMetric(observations: MetricObservation[]): AggregateStats {
  const values = observations.flatMap((observation) =>
    observation.ok && observation.value !== null && Number.isFinite(observation.value)
      ? [observation.value]
      : []
  )
  const nAttempted = observations.length
  const nFailed = observations.filter((observation) => !observation.ok).length
  const nUnavailable = observations.filter(
    (observation) =>
      observation.ok && (observation.value === null || !Number.isFinite(observation.value))
  ).length
  const nValid = values.length
  if (values.length === 0) {
    return {
      median: null,
      p25: null,
      p75: null,
      iqr: null,
      nAttempted,
      nValid,
      nUnavailable,
      nFailed
    }
  }
  const [p25, median, p75] = quantilesInclusive(values)
  return {
    median,
    p25,
    p75,
    iqr: p75 - p25,
    nAttempted,
    nValid,
    nUnavailable,
    nFailed
  }
}
