'use strict'

const { QvacResponse } = require('@qvac/infer-base')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Encapsulates the JS-side continuous-batching flow that sits on top of
 * `LlmLlamacpp`: input classification, per-prompt id assignment and
 * validation, native `runJob` admission, and reassembly of streaming
 * `BatchOutput` chunks plus the final ordered `BatchResult` array
 * delivered alongside the addon's terminal `JobEnded` event.
 *
 * Composition over inheritance: `LlmLlamacpp` owns one instance and
 * forwards batch-only events here. The single-prompt path in
 * `LlmLlamacpp` is unaffected.
 */
class BatchHandler {
  /**
   * @param {Object} deps
   * @param {Object} deps.job - exclusive job handler from LlmLlamacpp
   * @param {Function} deps.parsePrompt - (prompt, runOptions) -> addon messages
   * @param {Function} deps.cancelHandler - cancels the in-flight job
   * @param {Function} deps.runJob - (items) => Promise<boolean> admission ack
   */
  constructor ({ job, parsePrompt, cancelHandler, runJob }) {
    this._job = job
    this._parsePrompt = parsePrompt
    this._cancelHandler = cancelHandler
    this._runJob = runJob
    this._nextId = 0
    this._activeIds = null
    this._pendingResult = null
  }

  /**
   * Classify a `run()` argument. Batch inputs are arrays of either raw
   * `Message[]` prompts or `{ id?, prompt, runOptions? }` wrappers; the
   * single-prompt path keeps the legacy `Message[]` shape.
   */
  static isBatchInput (prompt) {
    if (!Array.isArray(prompt) || prompt.length === 0) return false
    const first = prompt[0]
    return Array.isArray(first) ||
      (
        first &&
        typeof first === 'object' &&
        !Array.isArray(first) &&
        Array.isArray(first.prompt)
      )
  }

  get isActive () { return this._activeIds !== null }

  /**
   * Validate, normalize and ship a batch input to the native addon.
   * Returns the `QvacResponse` carrying `response.ids` so callers can
   * correlate streaming chunks. Caller guards against busy state before
   * invoking; this method only mutates active-batch state once admission
   * succeeds.
   */
  async run (batchInput) {
    const items = this._normalizeItems(batchInput)
    const ids = items.map(item => item.id)
    const response = new QvacResponse({ cancelHandler: this._cancelHandler })
    response.ids = ids
    this._job.startWith(response)

    let accepted
    try {
      accepted = await this._runJob(items)
    } catch (err) {
      this._job.fail(err)
      throw err
    }
    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this._activeIds = ids
    this._pendingResult = null
    return response
  }

  /** Forward a streaming `BatchOutput` event into the active job. */
  onOutput (data) {
    this._job.output({ id: data.id, chunk: data.output })
  }

  /** Stash the final ordered output array so JobEnded can package it. */
  onResult (data) {
    this._pendingResult = data
  }

  /**
   * If a batch is in flight, build the `[ { id, output } ]` array that
   * the consumer-facing `await()` resolves with. Returns `null` for
   * non-batch jobs so the caller can fall back to its own JobEnded path.
   */
  buildFinalResultIfActive () {
    if (!this._activeIds) return null
    const outputs = Array.isArray(this._pendingResult) ? this._pendingResult : []
    return this._activeIds.map((id, index) => ({
      id,
      output: outputs[index] || ''
    }))
  }

  /** Drop active-batch state; called from the response-finalized hook. */
  clear () {
    this._activeIds = null
    this._pendingResult = null
  }

  _createId () {
    this._nextId += 1
    return `batch-${this._nextId}`
  }

  _normalizeItems (batchInput) {
    if (!Array.isArray(batchInput) || batchInput.length === 0) {
      throw new TypeError('Batch input must be a non-empty array')
    }
    const seenIds = new Set()
    return batchInput.map((item) => {
      const isWrapped = item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Array.isArray(item.prompt)
      const id = isWrapped && item.id !== undefined ? item.id : this._createId()
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('Batch prompt id must be a non-empty string when provided')
      }
      if (seenIds.has(id)) {
        throw new TypeError(`Duplicate batch prompt id: ${id}`)
      }
      seenIds.add(id)
      const prompt = isWrapped ? item.prompt : item
      const itemRunOptions = isWrapped && item.runOptions ? item.runOptions : {}
      return { id, messages: this._parsePrompt(prompt, itemRunOptions) }
    })
  }
}

module.exports = BatchHandler
module.exports.RUN_BUSY_ERROR_MESSAGE = RUN_BUSY_ERROR_MESSAGE
