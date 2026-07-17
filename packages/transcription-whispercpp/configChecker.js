'use strict'

const REQUIRED_SECTIONS = ['whisperConfig', 'contextParams', 'miscConfig']

// Mirror of the C++ WHISPER_MAIN_HANDLERS keys (WhisperHandlers.cpp) plus the
// JS-only nested `vadParams` object. Keep the two lists in sync: a key without
// a handler here is silently rejected, and a handler without a key here can
// never reach the addon.
const WHISPER_CONFIG_KEYS = [
  'strategy',
  'n_threads',
  'n_max_text_ctx',
  'offset_ms',
  'duration_ms',
  'translate',
  'no_context',
  'no_timestamps',
  'single_segment',
  'print_special',
  'print_progress',
  'print_realtime',
  'print_timestamps',
  'token_timestamps',
  'thold_pt',
  'thold_ptsum',
  'max_len',
  'split_on_word',
  'max_tokens',
  'debug_mode',
  'audio_ctx',
  'tdrz_enable',
  'suppress_regex',
  'initial_prompt',
  'language',
  'suppress_blank',
  'suppress_nst',
  'temperature',
  'max_initial_ts',
  'length_penalty',
  'temperature_inc',
  'entropy_thold',
  'logprob_thold',
  'no_speech_thold',
  'greedy_best_of',
  'beam_search_beam_size',
  'vad_model_path',
  'seed',
  'vadParams'
]

const VAD_PARAM_KEYS = [
  'threshold',
  'min_speech_duration_ms',
  'min_silence_duration_ms',
  'max_speech_duration_s',
  'speech_pad_ms',
  'samples_overlap'
]

const CONTEXT_PARAM_KEYS = ['model', 'use_gpu', 'flash_attn', 'gpu_device']

const MISC_PARAM_KEYS = ['caption_enabled', 'seed']

const MAX_SUPPRESS_REGEX_LENGTH = 512

// Reject grouping constructs entirely to prevent nested quantifier patterns
// like (a+)+ that cause catastrophic backtracking.
const SAFE_SUPPRESS_REGEX = /^[^()]*$/

/**
 * Validates a whisper configuration object, throwing on any unknown or
 * malformed parameter. The object must contain the `whisperConfig`,
 * `contextParams`, and `miscConfig` sections; `whisperConfig.vadParams` is
 * optional.
 * @param {Object} configObject - the configuration object to check
 * @returns {void}
 */
function checkConfig(configObject) {
  validateRequiredSections(configObject)
  validateMiscConfigKeys(configObject.miscConfig)
  validateWhisperConfigKeys(configObject.whisperConfig)
  validateVadParamsKeys(configObject.whisperConfig.vadParams)
  validateContextParamsKeys(configObject.contextParams)
  validateSuppressRegex(configObject.whisperConfig.suppress_regex)
}

function validateRequiredSections(configObject) {
  for (const section of REQUIRED_SECTIONS) {
    if (!configObject[section]) {
      throw new Error(`${section} object is required`)
    }
  }
}

function assertKnownKeys(values, allowedKeys, sectionName) {
  for (const key of Object.keys(values)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${key} is not a valid parameter for ${sectionName}`)
    }
  }
}

function validateMiscConfigKeys(miscConfig) {
  assertKnownKeys(miscConfig, MISC_PARAM_KEYS, 'miscConfig')
}

function validateWhisperConfigKeys(whisperConfig) {
  assertKnownKeys(whisperConfig, WHISPER_CONFIG_KEYS, 'whisperConfig')
}

function validateVadParamsKeys(vadParams) {
  if (!vadParams) {
    return
  }
  assertKnownKeys(vadParams, VAD_PARAM_KEYS, 'vadParams')
}

function validateContextParamsKeys(contextParams) {
  assertKnownKeys(contextParams, CONTEXT_PARAM_KEYS, 'contextParams')
}

function validateSuppressRegex(pattern) {
  if (typeof pattern !== 'string') {
    return
  }
  if (pattern.length > MAX_SUPPRESS_REGEX_LENGTH) {
    throw new Error(
      'suppress_regex exceeds maximum length of ' + MAX_SUPPRESS_REGEX_LENGTH + ' characters'
    )
  }
  if (!SAFE_SUPPRESS_REGEX.test(pattern)) {
    throw new Error(
      'suppress_regex must not contain grouping constructs (parentheses) to prevent catastrophic backtracking'
    )
  }
}

module.exports = {
  checkConfig
}
