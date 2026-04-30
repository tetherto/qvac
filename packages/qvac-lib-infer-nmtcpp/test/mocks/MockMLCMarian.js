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
const { createJobHandler } = require('@qvac/infer-base')

class MLCMarian {
  constructor (args, config) {
    this.args = args
    this.config = config
    this.addon = null
    this._job = createJobHandler({ cancel: () => this.addon.cancel() })
  }

  async load () {
    const configurationParams = {
      config: this.config
    }
    this.addon = this.createAddon(configurationParams)
    await this.addon.activate()
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
      return this._job.end(this.opts?.stats ? data : null)
    }

    if (event.includes('Error')) {
      return this._job.fail(error || data)
    }

    if (typeof data === 'string' || Array.isArray(data) || (typeof data === 'object' && data !== null)) {
      return this._job.output(data)
    }
  }

  async _runInternal (input) {
    this.addon.runJob({ type: 'text', input })
    return this._job.start()
  }

  async destroy () {
    if (this.addon) {
      await this.addon.destroy()
    }
  }
}

module.exports = MLCMarian
