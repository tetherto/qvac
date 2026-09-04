// Maps an SDK model type (or a serve-only alias for one) to the endpoint
// category that routes match against.
const ENDPOINT_CATEGORY: Record<string, string> = {
  llm: 'chat',
  'llamacpp-completion': 'chat',
  embeddings: 'embedding',
  embedding: 'embedding',
  'llamacpp-embedding': 'embedding',
  whisper: 'transcription',
  'whispercpp-transcription': 'transcription',
  'whispercpp-audio-translation': 'audio-translation',
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
  'sdcpp-generation': 'image'
}

export function normalizeEndpointCategory(sdkType: string): string {
  return ENDPOINT_CATEGORY[sdkType] ?? sdkType
}
