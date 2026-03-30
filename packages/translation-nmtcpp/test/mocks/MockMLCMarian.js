'use strict'

/**
 * Mock MLCMarian Translation Model
 *
 * Simulates the MLCMarian translation model for testing without native code.
 * Uses MockAddon internally to simulate addon behavior.
 * Matches the new API shape: runJob (no append/status/pause/stop).
 *
 * Methods:
 *   - load(): Initialize and activate the mock addon
 *   - run(input): Process input text and return QvacResponse
 *   - destroy(): Clean up resources
 *
 * Used by: test/unit/addon.inference.test.js
 */

const AddonInterface = require('./MockAddon')
const { QvacResponse } = require('@qvac/infer-base')

const JOB_ID = 'job'

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

  createAddon (configurationParams) {
    return new AddonInterface(
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    if (typeof data === 'object' && data !== null && 'TPS' in data) {
      return this._outputCallback(addon, 'JobEnded', JOB_ID, data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (typeof data === 'string') {
      mappedEvent = 'Output'
    } else if (Array.isArray(data)) {
      mappedEvent = 'Output'
    } else if (typeof data === 'object' && data !== null) {
      mappedEvent = 'Output'
    }

    return this._outputCallback(addon, mappedEvent, JOB_ID, data, error)
  }

  _outputCallback (addon, event, jobId, data, error) {
    const response = this._jobToResponse.get(jobId)
    if (!response) return

    if (event === 'Error') {
      response.failed(error)
      this._deleteJobMapping(jobId)
    } else if (event === 'Output') {
      response.updateOutput(data)
    } else if (event === 'JobEnded') {
      if (this.opts?.stats) {
        response.updateStats(data)
      }
      response.ended()
      this._deleteJobMapping(jobId)
    }
  }

  _saveJobToResponseMapping (jobId, response) {
    this._jobToResponse.set(jobId, response)
  }

  _deleteJobMapping (jobId) {
    this._jobToResponse.delete(jobId)
  }

  async _runInternal (input) {
    this.addon.runJob({ type: 'text', input })

    const response = new QvacResponse({
      cancelHandler: () => this.addon.cancel(),
      pauseHandler: () => Promise.resolve(),
      continueHandler: () => this.addon.activate()
    })

    this._saveJobToResponseMapping(JOB_ID, response)
    return response
  }

  async destroy () {
    if (this.addon) {
      await this.addon.destroy()
    }
  }
}

module.exports = MLCMarian
