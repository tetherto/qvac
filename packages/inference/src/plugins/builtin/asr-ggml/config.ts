import type ASRGgml from '@qvac/asr-ggml'
import type { ParakeetConfig, WhisperConfig, MossTranscribeConfig } from '@/schemas/index'
import { ModelLoadFailedError } from '@/errors/index'
import { withNativeKeys } from '@/utils/native-keys'

/**
 * Artifact key under which the parakeet plugin's `resolveConfig` stores the
 * resolved `speakerAttribution.modelSrc`; the addon wants that path, not the
 * source it was resolved from.
 */
export const SPEAKER_ATTRIBUTION_MODEL_PATH = 'speakerAttributionModelPath'

export const WHISPER_NATIVE_KEYS = {
  threads: 'n_threads',
  nMaxTextCtx: 'n_max_text_ctx',
  offsetMs: 'offset_ms',
  durationMs: 'duration_ms',
  audioCtx: 'audio_ctx',
  noContext: 'no_context',
  noTimestamps: 'no_timestamps',
  singleSegment: 'single_segment',
  printSpecial: 'print_special',
  printProgress: 'print_progress',
  printRealtime: 'print_realtime',
  printTimestamps: 'print_timestamps',
  tokenTimestamps: 'token_timestamps',
  tholdPt: 'thold_pt',
  tholdPtsum: 'thold_ptsum',
  maxLen: 'max_len',
  splitOnWord: 'split_on_word',
  maxTokens: 'max_tokens',
  debugMode: 'debug_mode',
  tdrzEnable: 'tdrz_enable',
  suppressRegex: 'suppress_regex',
  initialPrompt: 'initial_prompt',
  carryInitialPrompt: 'carry_initial_prompt',
  suppressBlank: 'suppress_blank',
  suppressNst: 'suppress_nst',
  lengthPenalty: 'length_penalty',
  temperatureInc: 'temperature_inc',
  entropyThold: 'entropy_thold',
  logprobThold: 'logprob_thold',
  greedyBestOf: 'greedy_best_of',
  beamSize: 'beam_search_beam_size',
  maxInitialTs: 'max_initial_ts',
  noSpeechThold: 'no_speech_thold',
  vadParams: 'vad_params',
  audioFormat: 'audio_format'
} as const satisfies Partial<Record<keyof WhisperConfig, string>>

const VAD_NATIVE_KEYS = {
  minSpeechDurationMs: 'min_speech_duration_ms',
  minSilenceDurationMs: 'min_silence_duration_ms',
  maxSpeechDurationS: 'max_speech_duration_s',
  speechPadMs: 'speech_pad_ms',
  samplesOverlap: 'samples_overlap'
} as const

export const WHISPER_CONTEXT_NATIVE_KEYS = {
  useGpu: 'use_gpu',
  flashAttention: 'flash_attn',
  gpuDevice: 'gpu_device',
  mainGpu: 'main-gpu'
} as const

export const WHISPER_MISC_NATIVE_KEYS = { captionEnabled: 'caption_enabled' } as const

function omitUndefined<T extends Record<string, unknown>>(config: T) {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
}

function buildWhisperConfig(config: WhisperConfig) {
  const {
    contextParams: _contextParams,
    miscConfig: _miscConfig,
    vadModelSrc: _vadModelSrc,
    detectLanguage,
    vadParams,
    ...rest
  } = config
  const whisperConfig = withNativeKeys(
    { ...rest, ...(vadParams && { vadParams: withNativeKeys(vadParams, VAD_NATIVE_KEYS) }) },
    WHISPER_NATIVE_KEYS
  )
  if (detectLanguage === true) {
    whisperConfig['language'] = 'auto'
  }
  return whisperConfig
}

function buildMiscConfig(config: WhisperConfig) {
  return config.miscConfig && withNativeKeys(config.miscConfig, WHISPER_MISC_NATIVE_KEYS)
}

export function buildWhisperEngineConfig(config: WhisperConfig) {
  const whisperConfig = buildWhisperConfig(config)
  const miscConfig = buildMiscConfig(config)
  return {
    engine: 'whisper',
    whisperConfig: whisperConfig as ASRGgml.WhisperConfig,
    ...(config.contextParams && {
      contextParams: withNativeKeys(config.contextParams, WHISPER_CONTEXT_NATIVE_KEYS)
    }),
    ...(miscConfig && { miscConfig })
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
  const miscConfig = buildMiscConfig(config)
  return {
    whisperConfig,
    ...(miscConfig && { miscConfig })
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
