'use strict'

const path = require('bare-path')

const inferBaseSrcDir = path.join(
  path.dirname(require.resolve('@qvac/infer-base/WeightsProvider/BaseInference.js')),
  '..',
  'src'
)

let QvacResponse
try {
  QvacResponse = require('@qvac/response')
} catch {
  QvacResponse = require(path.join(inferBaseSrcDir, 'QvacResponse'))
}

const { QvacInferenceBaseError, ERR_CODES } = require(path.join(inferBaseSrcDir, 'error'))

function dataAsString (data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

/**
 * Job/response map, QvacResponse wiring, output routing, and optional exclusive run queue.
 * @param {Object} params
 * @param {import('@qvac/logging')} params.logger
 * @param {Object} params.opts
 * @param {boolean} params.exclusiveRun
 * @param {() => unknown | null | undefined} params.getAddon
 */
function createJobHandler ({ logger, opts, exclusiveRun, getAddon }) {
  const jobToResponse = new Map()
  let runQueueWaiter = Promise.resolve()

  function saveJobToResponseMapping (jobId, response) {
    jobToResponse.set(jobId, response)
  }

  function deleteJobMapping (jobId) {
    jobToResponse.delete(jobId)
  }

  function createResponse (jobId) {
    const addon = getAddon()
    if (!addon) {
      throw new QvacInferenceBaseError({ code: ERR_CODES.ADDON_NOT_INITIALIZED })
    }
    const response = new QvacResponse({
      cancelHandler: () => {
        return addon.cancel(jobId)
      },
      pauseHandler: () => {
        return addon.pause()
      },
      continueHandler: () => {
        return addon.activate()
      }
    })
    saveJobToResponseMapping(jobId, response)
    return response
  }

  function outputCallback (addon, event, jobId, data, error) {
    const response = jobToResponse.get(jobId)
    if (!response) {
      logger.warn(`No response found for job ${jobId}`)
      return
    }

    if (event === 'Error') {
      logger.error(`Job ${jobId} failed with error: ${error}`)
      response.failed(error)
      deleteJobMapping(jobId)
    } else if (event === 'Output') {
      try {
        logger.debug(`Job ${jobId} produced output: ${dataAsString(data)}`)
      } catch (err) {
        if (err instanceof RangeError) {
          logger.debug(`Job ${jobId} produced output: [data too large]`)
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
      logger.info(`Job ${jobId} completed. Stats: ${JSON.stringify(data)}`)
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
      deleteJobMapping(jobId)
    } else {
      logger.debug(`Received event for job ${jobId}: ${event}`)
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
    jobToResponse,
    saveJobToResponseMapping,
    deleteJobMapping,
    createResponse,
    outputCallback,
    run
  }
}

module.exports = {
  createJobHandler
}
