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
    'beam_search_beam_size'
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

  // Only parameters wired through to the C++ addon are accepted. Adding
  // smoothing/sample-rate knobs here without consuming them in NeuralProcessor
  // would silently drop user intent, so they are kept out until implemented.
  //
  // `day_idx` is an integer session index.
  //   - day_idx >= 0 applies the day-specific projection matrices from
  //     bci-embedder.bin, clamped to the valid range at the C++ layer.
  //   - day_idx === -1 is a passthrough escape hatch that skips
  //     preprocessing entirely and treats the input buffer as
  //     pre-computed 512-bin mel features in frame-major layout. Useful
  //     for reproducing the Python reference output end-to-end.
  const validBCIParams = [
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
    const dayIdx = configObject.bciConfig.day_idx
    if (dayIdx !== undefined) {
      if (typeof dayIdx !== 'number' || !Number.isFinite(dayIdx) || !Number.isInteger(dayIdx)) {
        throw new Error('bciConfig.day_idx must be a finite integer')
      }
      if (dayIdx < -1) {
        throw new Error('bciConfig.day_idx must be >= -1 (use -1 to enable mel-passthrough mode)')
      }
    }
  }
}

module.exports = { checkConfig }
