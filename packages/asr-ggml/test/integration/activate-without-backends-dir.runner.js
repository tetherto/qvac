'use strict'

const process = require('bare-process')
const { WhisperInterface } = require('@qvac/asr-ggml/test-support.js')
const binding = require('../../binding')

const MODEL_PATH_ARG_INDEX = 2
const EXIT_SUCCESS = 0
const EXIT_FAILURE = 1

function readModelPath() {
  return process.argv[MODEL_PATH_ARG_INDEX]
}

function buildConfigWithoutBackendsDir(modelPath) {
  return {
    contextParams: { model: modelPath },
    whisperConfig: { language: 'en', duration_ms: 0, temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  }
}

function ignoreOutput() {}

async function destroyQuietly(model) {
  try {
    await model.destroyInstance()
  } catch {}
}

async function activateWithoutBackendsDir(modelPath) {
  const config = buildConfigWithoutBackendsDir(modelPath)
  const model = new WhisperInterface(binding, config, ignoreOutput)
  await model.activate()
  await destroyQuietly(model)
}

function reportFailure(error) {
  console.error(error.message)
  process.exit(EXIT_FAILURE)
}

function reportSuccess() {
  process.exit(EXIT_SUCCESS)
}

activateWithoutBackendsDir(readModelPath()).then(reportSuccess, reportFailure)
