'use strict'

const EventEmitter = require('bare-events')

const statuses = Object.freeze({
  RUNNING: 'running',
  ENDED: 'ended',
  ERRORED: 'errored',
  CANCELLED: 'cancelled',
  PAUSED: 'paused'
})

const _deprecationWarned = {}
function _warnDeprecated (method) {
  if (_deprecationWarned[method]) return
  _deprecationWarned[method] = true
  console.warn(`@qvac/infer-base: QvacResponse.${method}() is deprecated and will be removed in a future version.`)
}

/**
 * QvacResponse provides an interface for handling asynchronous responses
 * with update notifications, error handling, pause/resume functionality, and more.
 * It extends EventEmitter to allow event-based interaction.
 */
class QvacResponse extends EventEmitter {
  _status = statuses.RUNNING

  /**
   * Creates a new QvacResponse instance.
   * @param {Object} handlers - An object containing handler functions.
   * @param {Function} handlers.cancelHandler - A function that returns a Promise, called to cancel the response.
   * @param {Function} [handlers.pauseHandler] - @deprecated A function that returns a Promise, called to pause the response.
   * @param {Function} [handlers.continueHandler] - @deprecated A function that returns a Promise, called to continue the response.
   * @param {number} [pollInterval=100] - Polling interval in milliseconds for the async iterator.
   */
  constructor (
    { cancelHandler, pauseHandler, continueHandler } = {},
    pollInterval = 100
  ) {
    super()
    this.output = []
    this.stats = {}
    this._cancelHandler = cancelHandler
    this._pauseHandler = pauseHandler
    this._continueHandler = continueHandler
    this._pollInterval = pollInterval

    this._finishPromise = new Promise((resolve, reject) => {
      this._resolveFinish = resolve
      this._rejectFinish = reject
    })

    this._finishPromise.catch(() => {}) // Error already handled via error event if listener exists
  }

  /**
   * Registers a callback to be invoked on each output update.
   * @param {Function} callback - Function invoked with each output update.
   * @returns {QvacResponse} The current instance for chaining.
   */
  onUpdate (callback) {
    this.on('output', callback)
    return this
  }

  /**
   * Registers a callback for when the response finishes.
   * If a callback is provided, it is invoked with the terminal result.
   * @param {Function} [callback] - Optional callback invoked with the terminal result.
   * @returns {QvacResponse} The current instance for chaining.
   */
  onFinish (callback) {
    if (callback) {
      this.once('end', (result) => callback(result))
    }
    return this
  }

  /**
   * Returns a promise that resolves with the terminal result when the response finishes.
   * @returns {Promise<any>} A promise that resolves with the terminal result or rejects if an error occurs.
   */
  await () {
    return this._finishPromise
  }

  /**
   * Registers a callback to be invoked when an error occurs.
   * @param {Function} callback - Function invoked with the error.
   * @returns {QvacResponse} The current instance for chaining.
   */
  onError (callback) {
    this.on('error', callback)
    return this
  }

  /**
   * Registers a callback to be invoked when the response is cancelled.
   * @param {Function} callback - Function invoked when a cancel event occurs.
   * @returns {QvacResponse} The current instance for chaining.
   */
  onCancel (callback) {
    this.on('cancel', callback)
    return this
  }

  /**
   * @deprecated Will be removed in a future version.
   * Registers a callback to be invoked when the response is paused.
   * @param {Function} callback - Function invoked when a pause event occurs.
   * @returns {QvacResponse} The current instance for chaining.
   */
  onPause (callback) {
    _warnDeprecated('onPause')
    this.on('pause', callback)
    return this
  }

  /**
   * @deprecated Will be removed in a future version.
   * Registers a callback to be invoked when the response continues from a paused state.
   * @param {Function} callback - Function invoked when a continue event occurs.
   * @returns {QvacResponse} The current instance for chaining.
   */
  onContinue (callback) {
    _warnDeprecated('onContinue')
    this.on('continue', callback)
    return this
  }

  /**
   * Adds an output update and emits an 'output' event.
   * @param {*} output - The output data to add.
   */
  updateOutput (output) {
    this.output.push(output)
    this.emit('output', output)
  }

  /**
   * Updates the response statistics and emits a 'stats' event.
   * @param {*} stats - Statistics data.
   */
  updateStats (stats) {
    this.stats = stats
    this.emit('stats', stats)
  }

  /**
   * Marks the response as failed, emits an 'error' event, and rejects the finish promise.
   * @param {Error} error - The error that caused the failure.
   */
  failed (error) {
    if (!(error instanceof Error)) {
      error = new Error(String(error).trim())
    }

    this._status = statuses.ERRORED
    this._error = error
    const errorListeners = this.listenerCount('error')
    if (errorListeners > 0) {
      this.emit('error', error)
    }
    this._rejectFinish(error)
  }

  /**
   * Marks the response as ended, emits an 'end' event, and resolves the finish promise.
   */
  ended (result = this.output) {
    this._status = statuses.ENDED
    this.emit('end', result)
    this._resolveFinish(result)
  }

  /**
   * Returns the most recent output.
   * @returns {*} The latest output, or null if no output exists.
   */
  getLatest () {
    return this.output.length ? this.output.at(-1) : null
  }

  /**
   * Async generator that yields each output update until the response stops running.
   * @async
   * @generator
   * @yields {*} Each output update.
   * @throws {*} Throws an error if the response ends with an error status.
   */
  async * iterate () {
    if (this._status === statuses.ERRORED) {
      throw this._error
    }

    const sleep = delay => new Promise(resolve => setTimeout(resolve, delay))
    let i = 0
    while (true) {
      while (i < this.output.length) {
        yield this.output[i++]
      }
      if (this._status !== statuses.RUNNING) break
      await sleep(this._pollInterval)
    }

    if (this._status === statuses.ERRORED) throw this._error
  }

  /**
   * Cancels the response by invoking the cancel handler and emitting a 'cancel' event.
   * @returns {Promise<void>}
   * @throws {Error} If the response is not in a running state.
   */
  async cancel () {
    if (this._status !== statuses.RUNNING && this._status !== statuses.PAUSED) {
      return // Already finished/errored/cancelled
    }
    await this._cancelHandler()
    this.emit('cancel')
  }

  /**
   * @deprecated Will be removed in a future version. The single-job addon model has no pause semantics.
   * Pauses the response by invoking the pause handler and emitting a 'pause' event.
   * @returns {Promise<void>}
   * @throws {Error} If the response is not in a running state.
   */
  async pause () {
    _warnDeprecated('pause')
    if (this._status !== statuses.RUNNING) {
      throw new Error('ERR_NOT_RUNNING')
    }

    this._status = statuses.PAUSED
    await this._pauseHandler()
    this.emit('pause')
  }

  /**
   * @deprecated Will be removed in a future version. The single-job addon model has no pause semantics.
   * Continues a paused response by invoking the continue handler and emitting a 'continue' event.
   * @returns {Promise<void>}
   * @throws {Error} If the response is not in a paused state.
   */
  async continue () {
    _warnDeprecated('continue')
    if (this._status !== statuses.PAUSED) {
      throw new Error('ERR_NOT_PAUSED')
    }

    this._status = statuses.RUNNING
    await this._continueHandler()
    this.emit('continue')
  }

  /**
   * @deprecated Will be removed in a future version. Use response event listeners instead.
   * Returns the current status of the response.
   * @returns {string} The current status.
   */
  getStatus () {
    _warnDeprecated('getStatus')
    return this._status
  }
}

module.exports = QvacResponse
