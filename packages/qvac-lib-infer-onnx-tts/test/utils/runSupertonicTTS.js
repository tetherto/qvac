'use strict'

const path = require('bare-path')
const ONNXTTS = require('../..')
const { getBaseDir, runTTS } = require('./runTTS')

const SUPERTONIC_SAMPLE_RATE = 44100

async function loadSupertonicTTS (params = {}) {
  const defaultModelDir = path.resolve(path.join(getBaseDir(), 'models', 'supertonic'))

  const model = new ONNXTTS({
    files: {
      modelDir: params.modelDir || defaultModelDir
    },
    engine: 'supertonic',
    voiceName: params.voiceName || 'F1',
    speed: params.speed != null ? params.speed : 1,
    numInferenceSteps: params.numInferenceSteps != null ? params.numInferenceSteps : 5,
    supertonicMultilingual: params.supertonicMultilingual === true,
    config: {
      language: params.language || 'en'
    },
    opts: { stats: true }
  })
  await model.load()

  return model
}

async function runSupertonicTTS (model, params, expectation = {}) {
  return runTTS(model, params, expectation, {
    sampleRate: SUPERTONIC_SAMPLE_RATE,
    engineTag: 'Supertonic'
  })
}

module.exports = { loadSupertonicTTS, runSupertonicTTS }
