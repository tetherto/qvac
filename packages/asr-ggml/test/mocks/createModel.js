'use strict'

// Shared construction helpers for the mock-driven unit suite.
//
// SEAM CONTRACT — kept in exactly one file so implementation drift is a
// one-file fix:
//   1. `new ASRGgml({ files, config, ... })` constructs the orchestrator and
//      its engine driver synchronously; the driver is reachable at
//      `model._driver`.
//   2. The driver creates its native interface through
//      `_createAddon(configurationParams)` (extracted verbatim from both
//      parent packages) — the helpers below override it to inject a mocked
//      binding.
//   3. The driver exposes the live interface instance at `.addon` and its
//      native event mapper at `_outputCallback(addon, event, jobId, data,
//      error)`.
//   4. The orchestrator's single JobHandler is reachable at `model._job`
//      (fallback: the driver context's `job`).

const path = require('bare-path')
const ASRGgml = require('../../index.js')
const { WhisperInterface } = require('../../engines/whisper/whisper.js')
const { ParakeetInterface } = require('../../engines/parakeet/parakeet.js')
const WhisperMockedBinding = require('./MockedBinding.js')
const ParakeetMockedBinding = require('./ParakeetMockedBinding.js')
const { transitionCb } = require('./utils.js')

// Real files, so the constructor's strict existsSync validation passes
// without stubbing. The mocked bindings never read them: the GGML tiny model
// doubles as the whisper model, the VAD model, and (with an explicit
// engine: 'parakeet') the parakeet checkpoint.
const MODEL_PATH = path.join(__dirname, '..', 'model', 'ggml-tiny.bin')
const GGUF_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'tiny-magic.gguf')
const GGML_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'tiny-magic.ggml.bin')

function getDriver(model) {
  return model._driver || model.driver
}

function getAddon(model) {
  const driver = getDriver(model)
  return (driver && driver.addon) || model.addon
}

function getJob(model) {
  if (model._job) return model._job
  const driver = getDriver(model)
  if (!driver) return undefined
  return (
    driver._job || (driver.ctx && driver.ctx.job) || (driver._ctx && driver._ctx.job) || undefined
  )
}

function wrapOutputCallback(driver, onOutput) {
  return (addon, event, jobId, output, error) => {
    onOutput(addon, event, jobId, output, error)
    driver._outputCallback(addon, event, jobId, output, error)
  }
}

/**
 * Build a whisper-engine ASRGgml instance whose driver constructs
 * WhisperInterface over the given mocked binding.
 */
function createWhisperModel({
  binding = new WhisperMockedBinding(),
  onOutput = () => {},
  config = {},
  files = undefined,
  options = {}
} = {}) {
  const model = new ASRGgml({
    files: files || { model: MODEL_PATH, vadModel: MODEL_PATH },
    config: { engine: 'whisper', ...config },
    ...options
  })

  let resolveCaptured
  const capturedConfig = new Promise((resolve) => {
    resolveCaptured = resolve
  })

  const driver = getDriver(model)
  driver._createAddon = (configurationParams) => {
    resolveCaptured(configurationParams)
    return new WhisperInterface(
      binding,
      configurationParams,
      wrapOutputCallback(driver, onOutput),
      transitionCb
    )
  }

  model._mockedBinding = binding
  return { model, binding, capturedConfig }
}

/**
 * Build a parakeet-engine ASRGgml instance whose driver constructs
 * ParakeetInterface over the given mocked binding.
 */
function createParakeetModel({
  binding = new ParakeetMockedBinding(),
  onOutput = () => {},
  parakeetConfig = {},
  files = undefined,
  options = {}
} = {}) {
  const model = new ASRGgml({
    files: files || { model: MODEL_PATH },
    config: { engine: 'parakeet', parakeetConfig },
    ...options
  })

  let resolveCaptured
  const capturedConfig = new Promise((resolve) => {
    resolveCaptured = resolve
  })

  const driver = getDriver(model)
  driver._createAddon = (configurationParams) => {
    resolveCaptured(configurationParams)
    return new ParakeetInterface(
      binding,
      configurationParams,
      wrapOutputCallback(driver, onOutput),
      transitionCb
    )
  }

  model._mockedBinding = binding
  return { model, binding, capturedConfig }
}

/**
 * Minimal push-driven async iterable used by the streaming tests.
 */
function pushable() {
  const queue = []
  let waiter = null
  let ended = false
  return {
    push(chunk) {
      if (ended) return
      queue.push(chunk)
      if (waiter) {
        const w = waiter
        waiter = null
        w()
      }
    },
    end() {
      ended = true
      if (waiter) {
        const w = waiter
        waiter = null
        w()
      }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (ended) return
        await new Promise((resolve) => {
          waiter = resolve
        })
      }
    }
  }
}

module.exports = {
  MODEL_PATH,
  GGUF_FIXTURE_PATH,
  GGML_FIXTURE_PATH,
  getDriver,
  getAddon,
  getJob,
  createWhisperModel,
  createParakeetModel,
  pushable
}
