import type ASRGgml from '@qvac/asr-ggml'
import type { ParakeetConfig, WhisperConfig } from '@/schemas'

function omitUndefined<T extends Record<string, unknown>>(config: T) {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
}

function buildWhisperConfig(config: WhisperConfig) {
  const whisperConfig = omitUndefined(config)
  delete whisperConfig['contextParams']
  delete whisperConfig['miscConfig']
  delete whisperConfig['vadModelSrc']
  const detectLanguage = whisperConfig['detect_language']
  delete whisperConfig['detect_language']
  if (detectLanguage === true) {
    whisperConfig['language'] = 'auto'
  }
  return whisperConfig
}

export function buildWhisperEngineConfig(config: WhisperConfig) {
  const whisperConfig = buildWhisperConfig(config)
  return {
    engine: 'whisper',
    whisperConfig: whisperConfig as ASRGgml.WhisperConfig,
    ...(config.contextParams && {
      contextParams: omitUndefined(config.contextParams)
    }),
    ...(config.miscConfig && { miscConfig: omitUndefined(config.miscConfig) })
  } satisfies ASRGgml.WhisperEngineConfig
}

export function buildParakeetEngineConfig(config: ParakeetConfig) {
  return {
    engine: 'parakeet',
    parakeetConfig: omitUndefined(config)
  } satisfies ASRGgml.ParakeetEngineConfig
}

export function buildWhisperReloadConfig(config: WhisperConfig) {
  const whisperConfig = buildWhisperConfig(config)
  return {
    whisperConfig,
    ...(config.miscConfig && {
      miscConfig: omitUndefined(config.miscConfig)
    })
  } satisfies ASRGgml.ASRGgmlReloadConfig
}

export function buildParakeetReloadConfig(config: ParakeetConfig) {
  return {
    parakeetConfig: omitUndefined(config)
  } satisfies ASRGgml.ASRGgmlReloadConfig
}
