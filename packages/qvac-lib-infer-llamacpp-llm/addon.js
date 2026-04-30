const path = require('bare-path')

/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded` /
 * `FinetuneProgress`, or `null` to drop it. `state.skipNextRuntimeStats`
 * is used to swallow the TPS trailer that follows a finetune terminal.
 *
 * @param {string} rawEvent
 * @param {*} rawData
 * @param {*} rawError
 * @param {{ skipNextRuntimeStats: boolean }} state
 * @returns {{ type: string, data: *, error: * } | null}
 */
function mapAddonEvent (rawEvent, rawData, rawError, state) {
  // TPS-shaped runtime stats — either a real inference terminal or the stale
  // trailer that follows a finetune terminal.
  if (rawData && typeof rawData === 'object' && 'TPS' in rawData) {
    if (state.skipNextRuntimeStats) {
      state.skipNextRuntimeStats = false
      return null
    }
    const stats = { ...rawData }
    if (stats.backendDevice === 0) {
      stats.backendDevice = 'cpu'
    } else if (stats.backendDevice === 1) {
      stats.backendDevice = 'gpu'
    }
    return { type: 'JobEnded', data: stats, error: null }
  }

  // Finetune terminal: dispatch JobEnded carrying the finetune payload and arm
  // the skip flag so the TPS the C++ addon emits right after is not mistaken
  // for an inference result that would clobber `_hasActiveResponse`.
  if (
    rawData &&
    typeof rawData === 'object' &&
    rawData.op === 'finetune' &&
    typeof rawData.status === 'string'
  ) {
    state.skipNextRuntimeStats = true
    return { type: 'JobEnded', data: rawData, error: null }
  }

  // Per-iteration finetune metrics.
  if (
    rawData &&
    typeof rawData === 'object' &&
    rawData.type === 'finetune_progress'
  ) {
    return { type: 'FinetuneProgress', data: rawData, error: null }
  }

  // Name-based mapping. LogMsg must be checked before the string-to-Output
  // fallback: `JsLogMsgOutputHandler` delivers the log as a plain string,
  // so without this branch it would be misrouted into the job output.
  let type = rawEvent
  if (typeof rawEvent === 'string' && rawEvent.includes('Error')) {
    type = 'Error'
  } else if (typeof rawEvent === 'string' && rawEvent.includes('LogMsg')) {
    type = 'LogMsg'
  } else if (typeof rawData === 'string') {
    type = 'Output'
  }
  return { type, data: rawData, error: rawError }
}

/**
 * An interface between Bare addon in C++ and JS runtime.
 */
class LlamaInterface {
  /**
   *
   * @param {Object} configurationParams - all the required configuration for inference setup
   * @param {Function} outputCb - to be called on any inference event ( started, new output, error, etc )
   */
  constructor (binding, configurationParams, outputCb) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      outputCb,
      null
    )
  }

  /**
   * @param {Object} weightsData
   * @param {String} weightsData.filename
   * @param {Uint8Array|null} weightsData.chunk
   * @param {Boolean} weightsData.completed
   */
  async loadWeights (weightsData) {
    this._binding.loadWeights(this._handle, weightsData)
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  async activate () {
    this._binding.activate(this._handle)
  }

  /**
   * Cancel current inference job
   */
  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  /**
   * Run finetuning when native binding provides support.
   */
  async finetune (finetuningParams) {
    if (typeof this._binding.finetune !== 'function') {
      throw new Error('Finetuning is not exposed by this native binding')
    }
    if (finetuningParams === undefined) {
      throw new Error('Finetuning parameters are required')
    }
    return this._binding.finetune(this._handle, finetuningParams)
  }

  /**
   * Run one inference job with an array of message objects.
   * @param {Array<{type: string, input?: string, content?: Uint8Array}>} data - messages (text and/or media)
   */
  async runJob (data) {
    return this._binding.runJob(this._handle, data)
  }

  /**
   * Unload the model and clear resources (including memory).
   */
  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = {
  LlamaInterface,
  mapAddonEvent
}
