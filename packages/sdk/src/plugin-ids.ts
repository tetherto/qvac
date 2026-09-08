// Built-in plugin ids under the public @qvac/sdk name.

export const PLUGIN_LLM = '@qvac/sdk/llamacpp-completion/plugin' as const
export const PLUGIN_EMBEDDING = '@qvac/sdk/llamacpp-embedding/plugin' as const
export const PLUGIN_WHISPER = '@qvac/sdk/whispercpp-transcription/plugin' as const
export const PLUGIN_BCI = '@qvac/sdk/bci-whispercpp-transcription/plugin' as const
const PLUGIN_PARAKEET = '@qvac/sdk/parakeet-transcription/plugin' as const
export const PLUGIN_NMT = '@qvac/sdk/nmtcpp-translation/plugin' as const
export const PLUGIN_TTS = '@qvac/sdk/tts-ggml/plugin' as const
export const PLUGIN_OCR = '@qvac/sdk/ggml-ocr/plugin' as const
export const PLUGIN_DIFFUSION = '@qvac/sdk/sdcpp-generation/plugin' as const
export const PLUGIN_AUDIOGEN = '@qvac/sdk/audiogen-ggml/plugin' as const
export const PLUGIN_VLA = '@qvac/sdk/ggml-vla/plugin' as const
export const PLUGIN_CLASSIFICATION = '@qvac/sdk/ggml-classification/plugin' as const

export const SDK_DEFAULT_PLUGINS = [
  PLUGIN_LLM,
  PLUGIN_EMBEDDING,
  PLUGIN_WHISPER,
  PLUGIN_BCI,
  PLUGIN_PARAKEET,
  PLUGIN_NMT,
  PLUGIN_TTS,
  PLUGIN_OCR,
  PLUGIN_DIFFUSION,
  PLUGIN_AUDIOGEN,
  PLUGIN_VLA,
  PLUGIN_CLASSIFICATION
] as const

export type BuiltinPlugin = (typeof SDK_DEFAULT_PLUGINS)[number]
