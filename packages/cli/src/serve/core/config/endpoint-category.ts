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
  'audiogen-ggml': 'audiogen',
  'ggml-vla': 'vla',
  'ggml-classification': 'classification',
  'onnx-vad': 'vad'
}

export function normalizeEndpointCategory(sdkType: string): string {
  return ENDPOINT_CATEGORY[sdkType] ?? sdkType
}
