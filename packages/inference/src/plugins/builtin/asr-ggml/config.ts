import type ASRGgml from '@qvac/asr-ggml'
import type { ParakeetConfig, WhisperConfig, MossTranscribeConfig } from '@/schemas/index'
import { ModelLoadFailedError } from '@/errors/index'

/**
 * Artifact key under which the parakeet plugin's `resolveConfig` stores the
 * resolved `speakerAttribution.modelSrc`; the addon wants that path, not the
 * source it was resolved from.
 */
export const SPEAKER_ATTRIBUTION_MODEL_PATH = 'speakerAttributionModelPath'

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

/**
 * The addon-facing parakeet config. `speakerAttribution.modelSrc` is a model
 * source the SDK resolves before the load; the addon takes the resolved path
 * as `speakerAttribution.modelPath`.
 */
export function buildParakeetConfig(
  config: ParakeetConfig,
  artifacts?: Record<string, string>
): ASRGgml.ParakeetConfig {
  const { speakerAttribution, ...rest } = config
  const parakeetConfig = omitUndefined(rest) as ASRGgml.ParakeetConfig
  if (speakerAttribution === undefined) return parakeetConfig

  const modelPath = artifacts?.[SPEAKER_ATTRIBUTION_MODEL_PATH]
  if (!modelPath) {
    throw new ModelLoadFailedError(
      'speakerAttribution.modelSrc was not resolved to a diarization model path'
    )
  }
  const { modelSrc: _modelSrc, ...options } = speakerAttribution
  return {
    ...parakeetConfig,
    speakerAttribution: {
      modelPath,
      ...omitUndefined(options)
    } as ASRGgml.ParakeetSpeakerAttributionConfig
  }
}

export function buildParakeetEngineConfig(
  config: ParakeetConfig,
  artifacts?: Record<string, string>
) {
  return {
    engine: 'parakeet',
    parakeetConfig: buildParakeetConfig(config, artifacts)
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

/**
 * A reload merges into the loaded config, so leaving `speakerAttribution` out
 * keeps the diarization model the load resolved; the reload path has no
 * artifacts to resolve a new source with.
 */
export function buildParakeetReloadConfig(config: ParakeetConfig) {
  const { speakerAttribution: _speakerAttribution, ...rest } = config
  return {
    parakeetConfig: omitUndefined(rest)
  } satisfies ASRGgml.ASRGgmlReloadConfig
}

export function buildMossTranscribeEngineConfig(config: MossTranscribeConfig) {
  return {
    engine: 'moss-transcribe',
    mossTranscribeConfig: omitUndefined(config)
  } satisfies ASRGgml.MossTranscribeEngineConfig
}
