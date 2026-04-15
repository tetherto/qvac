'use strict'

/**
 * Validates BCI addon configuration.
 * @param {Object} configObject
 * @returns {void} or throws if invalid
 */
function checkConfig (configObject) {
  const requiredSections = ['whisperConfig', 'contextParams', 'miscConfig']

  for (const section of requiredSections) {
    if (!configObject[section]) {
      throw new Error(`${section} object is required`)
    }
  }

  const validWhisperParams = [
    'n_threads',
    'duration_ms',
    'translate',
    'no_timestamps',
    'single_segment',
    'print_special',
    'print_progress',
    'print_realtime',
    'print_timestamps',
    'language',
    'detect_language',
    'suppress_blank',
    'suppress_nst',
    'temperature',
    'greedy_best_of',
    'beam_search_beam_size',
    'seed'
  ]

  const validContextParams = [
    'model',
    'use_gpu',
    'flash_attn',
    'gpu_device'
  ]

  const validMiscParams = [
    'caption_enabled'
  ]

  const validBCIParams = [
    'smooth_kernel_std',
    'smooth_kernel_size',
    'sample_rate',
    'day_idx'
  ]

  for (const userParam of Object.keys(configObject.whisperConfig)) {
    if (!validWhisperParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for whisperConfig`)
    }
  }

  for (const userParam of Object.keys(configObject.contextParams)) {
    if (!validContextParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for contextParams`)
    }
  }

  for (const userParam of Object.keys(configObject.miscConfig)) {
    if (!validMiscParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for miscConfig`)
    }
  }

  if (configObject.bciConfig) {
    for (const userParam of Object.keys(configObject.bciConfig)) {
      if (!validBCIParams.includes(userParam)) {
        throw new Error(`${userParam} is not a valid parameter for bciConfig`)
      }
    }
  }
}

module.exports = { checkConfig }
