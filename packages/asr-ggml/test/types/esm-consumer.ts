import ASRGgml from '@qvac/asr-ggml'
import addonLogging from '@qvac/asr-ggml/addonLogging'

const whisperConfig: ASRGgml.WhisperConfig = {
  language: 'en',
  vad_params: { threshold: 0.6 }
}
const parakeetConfig: ASRGgml.ParakeetConfig = {
  maxThreads: 4
}
const options: ASRGgml.ASRGgmlOptions = {
  files: { model: '/models/model.gguf' },
  config: { engine: 'parakeet', parakeetConfig }
}
const constructor: typeof ASRGgml = ASRGgml
const backendId: ASRGgml.BackendId = ASRGgml.BackendId.CPU

void [whisperConfig, options, constructor, backendId, addonLogging]
