/*
 * @param {Object} configObject - the configuration object to check
*
* all objects most contain structure like this
* {
*   whisperConfig:{
*    vadParams:{},
*   },
*    contextParams:{}
*    miscConfig:{}
 * }
 * @returns {void} or throws an error if the config object is invalid
 */
function checkConfig (configObject) {
  const listOfConfigs = [
    'whisperConfig',
    'contextParams',
    'miscConfig'
  ]

  for (const config of listOfConfigs) {
    if (!configObject[config]) {
      throw new Error(`${config} object is required`)
    }
  }

  const listOfParamsWhisperConfig = [
    'strategy',
    'n_threads',
    'n_max_text_ctx',
    'offset_ms',
    'duration_ms',
    'audio_ctx',
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
    'tdrz_enable',
    'suppress_regex',
    'initial_prompt',
    'language',
    'detect_language',
    'suppress_blank',
    'suppress_nst',
    'temperature',
    'length_penalty',
    'temperature_inc',
    'entropy_thold',
    'logprob_thold',
    'greedy_best_of',
    'beam_search_beam_size',
    'vad_model_path',
    'seed',
    'vadParams'
  ]

  const listOfVadParams = [
    'threshold',
    'min_speech_duration_ms',
    'min_silence_duration_ms',
    'max_speech_duration_s',
    'speech_pad_ms',
    'samples_overlap'
  ]

  const listOfContextParams = [
    'model',
    'use_gpu',
    'flash_attn',
    'gpu_device'
  ]

  const listOfMiscParams = [
    'caption_enabled',
    'seed' // this is an internal c++ function call, not a whisper.cpp parameter under the hood
  ]

  for (const userParam of Object.keys(configObject.miscConfig)) {
    if (!listOfMiscParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for miscConfig`)
    }
  }

  // loop through each parameter if it doesnt exist in the lists throw an error
  for (const userParam of Object.keys(configObject.whisperConfig)) {
    if (!listOfParamsWhisperConfig.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for whisperConfig`)
    }
  }

  // Only validate vadParams if it exists
  if (configObject.whisperConfig.vadParams) {
    for (const userParam of Object.keys(configObject.whisperConfig.vadParams)) {
      if (!listOfVadParams.includes(userParam)) {
        throw new Error(`${userParam} is not a valid parameter for vadParams`)
      }
    }
  }

  for (const userParam of Object.keys(configObject.contextParams)) {
    if (!listOfContextParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for contextParams`)
    }
  }
};

module.exports = {
  checkConfig
}
