import type { ModelFitWorkload } from '@/schemas/assess-model-fit'
import type { ModelResourceProfile } from '@/schemas/model-resource-profile'

/** A memory bound. `lower` is the optimistic end, `upper` the conservative one. */
export interface ByteRange {
  lower: number
  upper: number
}

/**
 * Platforms a calibration fixture can cover. A platform absent from the shipped
 * fixtures assesses as `unknown`: an uncalibrated formula is not evidence.
 */
export type ModelFitPlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64'
  | 'android-arm64'
  | 'ios-arm64'

/**
 * Measured coefficients for one platform. Derived by the calibration harness
 * (`scripts/calibrate-model-fit.ts`) from real loads, then committed.
 *
 * @property weightUpperCoeff - Multiplier on `artifactBytes` for resident
 *   weights at the conservative end. The lower end is always 1.0: llama.cpp
 *   maps weights, so the file size is the floor.
 * @property fixedOverheadBytes - Runtime cost that does not scale with the
 *   workload: engine context, backend buffers, tokenizer.
 * @property computeBufferBytesPerToken - Compute/graph buffers that scale with
 *   the context the caller asks for.
 * @property audioWindowBytes - Whisper-family working memory for one 30 s
 *   window, the engine's own default window.
 * @property audioStreamingBytes - Extra resident cost of a streaming session.
 * @property validated - False while coefficients are provisional. An
 *   unvalidated platform assesses as `unknown`, exactly like a missing one.
 */
export interface PlatformCalibration {
  weightUpperCoeff: number
  fixedOverheadBytes: ByteRange
  computeBufferBytesPerToken: ByteRange
  audioWindowBytes: ByteRange
  audioStreamingBytes: ByteRange
  validated: boolean
  measuredAt?: string
  notes?: readonly string[]
}

export interface CalibrationFixture {
  schemaVersion: 1
  platforms: Partial<Record<ModelFitPlatform, PlatformCalibration>>
}

/** What an estimator is handed for one candidate. */
export interface EstimatorInput {
  profile: ModelResourceProfile
  workload: ModelFitWorkload
  /** Artifact bytes of companion constants the caller passed alongside. */
  extraArtifactBytes: number
  calibration: PlatformCalibration
  /**
   * Whether the device reports a GPU. Used only to decide which KV-cache type
   * the engine would default to — never as a memory budget, since GPU memory
   * metrics are `unverified`-scoped by design.
   */
  hasGpu: boolean
}

/**
 * An estimate, or a refusal to estimate.
 *
 * `persistent` stays resident for the model's whole lifetime; `working` is the
 * temporary peak of one operation. Aggregation treats them differently, which
 * is what makes `sequential` cheaper than `concurrent`.
 */
export type EstimatorResult =
  | {
      kind: 'estimate'
      estimatorVersion: string
      persistent: ByteRange
      working: ByteRange
      reasons: readonly string[]
      assumptions: readonly string[]
    }
  | {
      kind: 'unknown'
      estimatorVersion: string
      reasons: readonly string[]
      assumptions?: readonly string[]
    }
