'use strict'

/**
 * Mock Addon Interface
 *
 * Simulates the C++ addon behavior for testing without native code.
 * Matches the real TranslationInterface API shape: runJob, activate, cancel, destroy.
 *
 * Used by: test/mocks/MockMLCMarian.js, test/unit/*.test.js
 */

class AddonInterface {
  constructor (configurationParams, outputCb, transitionCb = null) {
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._destroyed = false
  }

  async loadWeights (weightsData) {
    // Weights loading is a no-op for mock
  }

  async activate () {
    // Activation is a no-op for mock
  }

  /**
   * Submits a job. Matches the real TranslationInterface.runJob() signature.
   * @param {Object} data - { type: 'text'|'sequences', input: string|string[] }
   * @returns {boolean} true if the job was accepted
   */
  runJob (data) {
    if (this._destroyed) return false

    const { type, input } = data

    if (type === 'text') {
      setImmediate(() => {
        this.outputCb(this, 'MockOutput', { type: 'number', data: input.length }, null)
      })
      setImmediate(() => {
        this.outputCb(this, 'MockStats', { TPS: 0, totalTokens: 0, totalTime: 0 }, null)
      })
      return true
    } else if (type === 'sequences') {
      setImmediate(() => {
        const results = input.map(text => `mock_${text}`)
        this.outputCb(this, 'MockBatchOutput', results, null)
      })
      setImmediate(() => {
        this.outputCb(this, 'MockStats', { TPS: 0, totalTokens: 0, totalTime: 0 }, null)
      })
      return true
    }

    setImmediate(() => {
      this.outputCb(this, 'MockError', null, `Unknown type: ${type}`)
    })
    return true
  }

  async cancel () {
    // Cancel is a no-op for mock
  }

  async destroy () {
    this._destroyed = true
  }
}

module.exports = AddonInterface
