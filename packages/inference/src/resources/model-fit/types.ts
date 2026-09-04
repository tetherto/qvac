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
 * @property measuredOn - What the harness observed while measuring. Recorded
 *   because these coefficients are keyed by platform alone, while the buffers
 *   they measure are allocated by the backend: a `linux-x64` fixture measured on
 *   CUDA is being applied to CPU-only hosts too. Stating each fixture's scope
 *   keeps that visible, and means the key could later gain a backend dimension
 *   without re-measuring anything. Absent on a placeholder, which measured
 *   nothing.
 */
export interface PlatformCalibration {
  weightUpperCoeff: number
  fixedOverheadBytes: ByteRange
  computeBufferBytesPerToken: ByteRange
  audioWindowBytes: ByteRange
  audioStreamingBytes: ByteRange
  validated: boolean
  measuredAt?: string
  measuredOn?: CalibrationProvenance
  notes?: readonly string[]
}

/**
 * The measurement conditions behind one set of coefficients.
 *
 * @property backend - Best-effort label for the backend in play during the run,
 *   inferred from the GPU drivers the resource collector reported: `metal`,
 *   `vulkan`, `cuda`, `rocm`, or `cpu`.
 * @property device - GPU name, when one was reported.
 * @property kvElementBytes - Bytes per KV-cache element the residuals were
 *   computed against. The single most useful number here: subtract the wrong
 *   width and the fit is wrong, so recording it makes a bad run auditable after
 *   the fact.
 */
export interface CalibrationProvenance {
  backend: string
  device?: string
  kvElementBytes: number
}

export interface CalibrationFixture {
  schemaVersion: 1
  platforms: Partial<Record<ModelFitPlatform, PlatformCalibration>>
  /**
   * GPU-resident coefficients, keyed `<platform>:<backend>`. Separate from
   * `platforms` because those describe CPU-resident execution in system RAM,
   * and because one platform can run several backends whose buffers differ.
   */
  gpuPlatforms?: Readonly<Record<string, PlatformCalibration>>
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
