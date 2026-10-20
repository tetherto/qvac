import type { ModelType } from '@qvac/sdk'

type CanonicalModelType = (typeof ModelType)[keyof typeof ModelType]

// Classifies every canonical SDK model type for discovery and route matching.
// Legacy aliases remain supported for existing serve configurations.
const ENDPOINT_CATEGORY: Record<CanonicalModelType, string> & Record<string, string> = {
  llm: 'chat',
  'llamacpp-completion': 'chat',
  embeddings: 'embedding',
  embedding: 'embedding',
  'llamacpp-embedding': 'embedding',
  'llamacpp-decision': 'decision',
  whisper: 'transcription',
  'whispercpp-transcription': 'transcription',
  bci: 'bci',
  'bci-whispercpp-transcription': 'bci',
  'whispercpp-audio-translation': 'audio-translation',
  'moss-transcribe': 'transcription',
  parakeet: 'transcription',
  'parakeet-transcription': 'transcription',
  nmt: 'translation',
  'nmtcpp-translation': 'translation',
  tts: 'speech',
  'tts-ggml': 'speech',
  'onnx-tts': 'speech',
  ocr: 'ocr',
  'ggml-ocr': 'ocr',
  // Legacy model type from the ONNX era — route to the OCR endpoint so the
  // SDK's migration error surfaces instead of a category-less 400.
  'onnx-ocr': 'ocr',
  diffusion: 'image',
  'sdcpp-generation': 'image',
  audiogen: 'audiogen',
  'audiogen-ggml': 'audiogen',
  vla: 'vla',
  'ggml-vla': 'vla',
  classification: 'classification',
  'ggml-classification': 'classification',
  vad: 'vad',
  'onnx-vad': 'vad'
}

// One sdcpp-generation model serves a single operation, picked by its
// `config.mode` at load time.
const SDCPP_MODE_CATEGORY: Record<string, string> = {
  diffusion: 'image',
  video: 'video',
  upscale: 'upscale',
  world: 'world'
}

export function normalizeEndpointCategory(sdkType: string): string {
  return ENDPOINT_CATEGORY[sdkType] ?? sdkType
}

/**
 * The category of a configured model, which for sdcpp-generation depends on
 * its mode. Throws on a mode the SDK would reject at load, so a typo fails at
 * startup instead of passing as `image`.
 */
export function endpointCategoryFor(sdkType: string, config: Record<string, unknown>): string {
  const category = normalizeEndpointCategory(sdkType)
  if (category !== 'image') return category
  const mode = config['mode']
  if (mode === undefined) return category
  const modeCategory = typeof mode === 'string' ? SDCPP_MODE_CATEGORY[mode] : undefined
  if (modeCategory === undefined) {
    const expected = Object.keys(SDCPP_MODE_CATEGORY)
      .map((m) => `"${m}"`)
      .join(', ')
    throw new Error(`config.mode: expected one of ${expected}, got ${JSON.stringify(mode)}`)
  }
  return modeCategory
}
