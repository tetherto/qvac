import fs from 'bare-fs'
import path from 'bare-path'
import type { ParakeetConfig } from '@/schemas/index'

/**
 * Parakeet models whose staged Core ML encoder loses text on long inputs.
 *
 * The pinned engine cuts every offline input longer than the encoder bundle
 * (1501 mel frames, 15 s) into 15 s windows when the bundle sits beside the
 * GGUF, where ggml alone would encode it in one pass. On those windows
 * Parakeet TDT 0.6B v3 drops whole sentences: a 60 s read-speech clip
 * decodes 108 of 318 tokens. Unified 0.6B takes the same windows but keeps
 * its text (60 s, 160 s, 180 s and 191 s clips match ggml), so it keeps the
 * engine default.
 *
 * Remove this once the asr-ggml pin carries the engine fix, which keeps the
 * fixed-shape windows for loads whose encoder only Core ML can run.
 */
const LONG_FORM_TEXT_LOSS_STEMS: ReadonlySet<string> = new Set(['parakeet-tdt-0.6b-v3'])

// The quantisation tags the engine strips from a GGUF name before it looks
// for `<stem>-encoder.mlmodelc` beside it (parakeet_coreml_path.cpp).
const GGUF_NAME = /^(.+)[.-](?:f32|f16|bf16|q8_0|q5_0|q4_0|q6_k|q5_k|q4_k|mxfp4|nvfp4)\.gguf$/

/** The encoder bundle path the engine loads for `modelPath`, for an affected model. */
function affectedEncoderBundlePath(modelPath: string): string | undefined {
  const match = GGUF_NAME.exec(path.basename(modelPath))
  const stem = match?.[1]
  if (stem === undefined || !LONG_FORM_TEXT_LOSS_STEMS.has(stem)) return undefined
  return path.join(path.dirname(modelPath), `${stem}-encoder.mlmodelc`)
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * The Parakeet config the load runs with: unchanged, except that a Parakeet
 * TDT 0.6B v3 GGUF with its Core ML encoder staged beside it, on macOS or iOS,
 * defaults `longFormWindowFrames` to `-1` when the caller left it unset.
 *
 * With `-1` the engine skips the 15 s Core ML window plan: an input that fits
 * the bundle still runs on Core ML, and a longer one runs the ggml encoder in
 * one pass, which gives the same transcript as ggml alone. A value the caller
 * set, including `0`, is kept.
 */
export function withCoremlLongFormDefault(
  config: ParakeetConfig,
  modelPath: string | undefined,
  platform: string | undefined,
  hasEncoderBundle: (bundlePath: string) => boolean = isDirectory
): ParakeetConfig {
  if (platform !== 'darwin' && platform !== 'ios') return config
  if (config.longFormWindowFrames !== undefined || !modelPath) return config
  const bundlePath = affectedEncoderBundlePath(modelPath)
  if (bundlePath === undefined || !hasEncoderBundle(bundlePath)) return config
  return { ...config, longFormWindowFrames: -1 }
}
