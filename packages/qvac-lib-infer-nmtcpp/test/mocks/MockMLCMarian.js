'use strict'

/**
 * Mock MLCMarian Translation Model
 *
 * Simulates the MLCMarian translation model for testing without native code.
 * Uses MockAddon internally to simulate addon behavior.
 *
 * Methods:
 *   - load(): Initialize and activate the mock addon
 *   - run(input): Process input text and return QvacResponse
 *   - pause()/unpause(): Pause/resume processing
 *   - stop(): Stop processing
 *   - status(): Get current addon state
 *
 * Used by: test/unit/addon.inference.test.js
 */

const AddonInterface = require('./MockAddon')
const { QvacResponse } = require('@qvac/infer-base')
const { transitionCb } = require('./utils.js')

const END_OF_INPUT = 'end of job'

class MLCMarian {
  _jobToResponse = new Map()

  constructor (args, config) {
    this.args = args
    this.config = config
    this.addon = null
  }

  async load (close = false) {
    await this.args.loader.ready()
    try {
      const configurationParams = {
        config: this.config
      }
      this.addon = this.createAddon(configurationParams)
      await this.addon.activate()
    } finally {
      if (close) {
        await this.args.loader.close()
      }
    }
  }

  async run (input) {
    return this._runInternal(input)
  }

  async pause () {
    await this.addon.pause()
  }

  async unpause () {
    await this.addon.activate()
  }

  async stop () {
    await this.addon.stop()
  }

  async status () {
    return this.addon.status()
  }

  createAddon (configurationParams) {
    return new AddonInterface(
      configurationParams,
      this._outputCallback.bind(this),
      transitionCb
    )
  }

  _outputCallback (addon, event, jobId, data, error) {
    const response = this._jobToResponse.get(jobId)
    if (event === 'Error') {
      console.log('Callback called with error. ', error)
      response.failed(error)
      this._deleteJobMapping(jobId)
    } else if (event === 'Output') {
      console.log(`Callback called for job: ${jobId} with data: ${dataAsString(data)}`)
      response.updateOutput(data)
    } else if (event === 'JobEnded') {
      console.log(`Callback called for job end: ${jobId}. Stats: ${JSON.stringify(data)}`)
      if (this.opts?.stats) {
        response.updateStats(data)
      }
      response.ended()
      this._deleteJobMapping(jobId)
    } else {
      console.log('jobId: ' + jobId + ', event: ' + event)
    }
  }

  _saveJobToResponseMapping (jobId, response) {
    this._jobToResponse.set(jobId, response)
  }

  _deleteJobMapping (jobId) {
    this._jobToResponse.delete(jobId)
  }

  async _runInternal (input) {
    const jobId = await this.addon.append({ type: 'text', input })
    const response = new QvacResponse({
      cancelHandler: () => {
        return this.addon.cancel(jobId)
      },
      pauseHandler: () => {
        return this.addon.pause()
      },
      continueHandler: () => {
        return this.addon.activate()
      }
    })
    this._saveJobToResponseMapping(jobId, response)
    await this.addon.append({ type: END_OF_INPUT })
    return response
  }
}

function dataAsString (data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

module.exports = MLCMarian
