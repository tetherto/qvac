import type { ByteRange, EstimatorInput, EstimatorResult } from '@/resources/model-fit/types'

export const WHISPER_ESTIMATOR_VERSION = 'whisper-v1'

/** Whisper's own default window, and therefore the calibration anchor. */
const CALIBRATION_WINDOW_MS = 30_000

/**
 * Estimates memory for a whisper.cpp transcription model.
 *
 * Whisper's encoder work is fixed by its 30 s window rather than by a growing
 * cache, so the shape is simpler than the LLM case: resident weights plus a
 * working peak that scales with the window the caller feeds it.
 */
export function estimateWhisper(input: EstimatorInput): EstimatorResult {
  const { profile, workload, calibration, extraArtifactBytes } = input

  if (workload.kind !== 'audio') {
    return {
      kind: 'unknown',
      estimatorVersion: WHISPER_ESTIMATOR_VERSION,
      reasons: [`workload kind '${workload.kind}' is not supported by ${WHISPER_ESTIMATOR_VERSION}`]
    }
  }

  // A zero here is an unmeasured placeholder, not a measurement: the harness
  // writes `{ lower: 0, upper: 0 }` until its whisper pass has run. Consuming
  // it would return a confident estimate whose entire audio working memory is
  // zero — the same failure shape as a mis-subtracted KV cache.
  if (calibration.audioWindowBytes.upper <= 0) {
    return {
      kind: 'unknown',
      estimatorVersion: WHISPER_ESTIMATOR_VERSION,
      reasons: [
        'the audio window coefficient for this platform has not been measured, so an audio estimate cannot be defended'
      ]
    }
  }
  if (workload.streaming && calibration.audioStreamingBytes.upper <= 0) {
    return {
      kind: 'unknown',
      estimatorVersion: WHISPER_ESTIMATOR_VERSION,
      reasons: [
        'the streaming-session coefficient for this platform has not been measured, so a streaming audio estimate cannot be defended'
      ]
    }
  }

  const assumptions: string[] = []
  const reasons: string[] = []

  const artifactBytes = profile.artifactBytes + extraArtifactBytes
  const persistent: ByteRange = {
    lower: artifactBytes,
    upper: Math.ceil(artifactBytes * calibration.weightUpperCoeff)
  }
  if (extraArtifactBytes > 0) {
    assumptions.push(
      'companion artifacts passed in `artifacts` (e.g. a VAD model) are counted at full size'
    )
  }

  const windows = workload.windowMs / CALIBRATION_WINDOW_MS
  const batch = workload.batch ?? 1
  const streamingLower = workload.streaming ? calibration.audioStreamingBytes.lower : 0
  const streamingUpper = workload.streaming ? calibration.audioStreamingBytes.upper : 0

  const working: ByteRange = {
    lower:
      calibration.fixedOverheadBytes.lower +
      calibration.audioWindowBytes.lower * windows * batch +
      streamingLower,
    upper:
      calibration.fixedOverheadBytes.upper +
      calibration.audioWindowBytes.upper * windows * batch +
      streamingUpper
  }

  reasons.push(
    `working memory scaled from the calibrated 30 s window to ${Math.round(workload.windowMs)} ms${batch > 1 ? ` × ${batch} concurrent windows` : ''}`
  )
  assumptions.push(
    'the audio window scales working memory linearly from the engine’s 30 s default; longer windows are chunked by the engine rather than held whole'
  )
  if (workload.streaming) {
    assumptions.push('a streaming session is assumed to keep one calibrated stream buffer resident')
  }

  return {
    kind: 'estimate',
    estimatorVersion: WHISPER_ESTIMATOR_VERSION,
    persistent,
    working: { lower: Math.ceil(working.lower), upper: Math.ceil(working.upper) },
    reasons,
    assumptions
  }
}
