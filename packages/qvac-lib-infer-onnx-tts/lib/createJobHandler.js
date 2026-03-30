'use strict'

const path = require('bare-path')

const inferBaseSrcDir = path.join(
  path.dirname(require.resolve('@qvac/infer-base/WeightsProvider/BaseInference.js')),
  '..',
  'src'
)

const QvacResponse = require(path.join(inferBaseSrcDir, 'QvacResponse'))

const { QvacInferenceBaseError, ERR_CODES } = require(path.join(inferBaseSrcDir, 'error'))
const { QvacErrorAddonTTS, ERR_CODES: TTS_ERR_CODES } = require('./error')

function dataAsString (data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

/**
 * Single active job response, QvacResponse wiring, output routing, and optional exclusive run queue.
 * @param {Object} params
 * @param {import('@qvac/logging')} params.logger
 * @param {Object} params.opts
 * @param {boolean} params.exclusiveRun
 * @param {() => unknown | null | undefined} params.getAddon
 */
function createJobHandler ({ logger, opts, exclusiveRun, getAddon }) {
  let activeResponse = null
  let runQueueWaiter = Promise.resolve()

  function clearActiveResponse () {
    activeResponse = null
  }

  /**
   * Fail the current active response (e.g. unload/reload) and clear the slot.
   * @param {Error | string} err
   */
  function failActive (err) {
    if (!activeResponse) return
    const e = err instanceof Error ? err : new Error(String(err))
    activeResponse.failed(e)
    clearActiveResponse()
  }

  function createResponse () {
    if (activeResponse) {
      throw new QvacErrorAddonTTS({ code: TTS_ERR_CODES.JOB_ALREADY_RUNNING })
    }
    const addon = getAddon()
    if (!addon) {
      throw new QvacInferenceBaseError({ code: ERR_CODES.ADDON_NOT_INITIALIZED })
    }
    const response = new QvacResponse({
      cancelHandler: () => {
        return addon.cancel()
      },
      pauseHandler: () => {
        return addon.pause()
      },
      continueHandler: () => {
        return addon.activate()
      }
    })
    activeResponse = response
    return response
  }

  function outputCallback (addon, event, data, error) {
    const response = activeResponse
    if (!response) {
      logger.warn('No active TTS job response for addon output')
      return
    }

    if (event === 'Error') {
      logger.error(`TTS job failed with error: ${error}`)
      response.failed(error)
      clearActiveResponse()
    } else if (event === 'Output') {
      try {
        logger.debug(`TTS job produced output: ${dataAsString(data)}`)
      } catch (err) {
        if (err instanceof RangeError) {
          logger.debug('TTS job produced output: [data too large]')
        } else {
          throw err
        }
      }
      response.updateOutput(data)
    } else if (event === 'FinetuneProgress') {
      if (opts?.stats) {
        response.updateStats(data.stats)
      }
    } else if (event === 'JobEnded') {
      logger.info(`TTS job completed. Stats: ${JSON.stringify(data)}`)
      const isFinetuneTerminal =
        data &&
        typeof data === 'object' &&
        data.op === 'finetune' &&
        typeof data.status === 'string'
      if (opts?.stats && !isFinetuneTerminal) {
        response.updateStats(data)
      }
      if (isFinetuneTerminal) {
        response.ended(data)
      } else {
        response.ended()
      }
      clearActiveResponse()
    } else {
      logger.debug(`Received TTS event: ${event}`)
    }
  }

  async function withExclusiveRun (fn) {
    const prev = runQueueWaiter || Promise.resolve()
    let release
    runQueueWaiter = new Promise(resolve => {
      release = resolve
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async function run (runInternal) {
    if (exclusiveRun) {
      return withExclusiveRun(() => runInternal())
    }
    return runInternal()
  }

  return {
    createResponse,
    outputCallback,
    failActive,
    run
  }
}

module.exports = {
  createJobHandler
}
