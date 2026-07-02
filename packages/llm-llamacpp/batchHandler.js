'use strict'

const { QvacResponse } = require('@qvac/infer-base')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Encapsulates the JS-side continuous-batching flow that sits on top of
 * `LlmLlamacpp`: input classification, prompt unwrapping, native
 * `runJob` admission, and reassembly of streaming `BatchOutput` chunks
 * plus the final ordered `BatchResult` array delivered with the addon's
 * terminal `JobEnded` event.
 *
 * Several batch groups may be in flight at once: each `run()` is admitted
 * as one tagged native job, and the group's terminal events (result,
 * jobEnded stats, error) are routed here by that native job id. Streaming
 * chunks are untagged but carry their per-prompt string id, routed via
 * `_chunkRoutes`.
 */
class BatchHandler {
  /**
   * @param {Object} deps
   * @param {Function} deps.parsePrompt - (prompt, runOptions) -> addon messages
   * @param {Function} deps.cancelHandler - cancels the in-flight work
   * @param {Function} deps.runJob - (items) => Promise<{accepted, ids, id}> admission result
   */
  constructor({ parsePrompt, cancelHandler, runJob }) {
    this._parsePrompt = parsePrompt
    this._cancelHandler = cancelHandler
    this._runJob = runJob
    /// native jobId -> { ids, response, pendingResult }
    this._groups = new Map()
    /// per-prompt string id -> native jobId, for routing streaming chunks
    this._chunkRoutes = new Map()
  }

  /**
   * Classify a `run()` argument. Batch inputs are arrays of either raw
   * `Message[]` prompts or `{ id?, prompt, runOptions? }` wrappers; the
   * single-prompt path keeps the legacy `Message[]` shape.
   */
  static isBatchInput(prompt) {
    if (!Array.isArray(prompt) || prompt.length === 0) return false
    const first = prompt[0]
    return (
      Array.isArray(first) ||
      (first && typeof first === 'object' && !Array.isArray(first) && Array.isArray(first.prompt))
    )
  }

  get isActive() {
    return this._groups.size > 0
  }

  /** Whether a tagged event belongs to one of the in-flight batch groups. */
  owns(jobId) {
    return typeof jobId === 'number' && this._groups.has(jobId)
  }

  /**
   * Ship a batch input to the native addon. Returns the `QvacResponse`
   * carrying `response.ids` so consumers can correlate streaming chunks.
   * Caller guards against busy state before invoking; this method only
   * registers group state once admission succeeds.
   */
  async run(batchInput) {
    const items = this._unwrapItems(batchInput)
    // Caller-supplied ids must not collide with another in-flight group, or
    // its streaming chunks would be routed to the wrong response. Auto-minted
    // ids are globally unique natively, so only explicit ids can clash.
    for (const item of items) {
      if (item.id !== undefined && this._chunkRoutes.has(item.id)) {
        throw new Error(`Batch prompt id already in flight: ${item.id}`)
      }
    }
    const response = new QvacResponse({ cancelHandler: this._cancelHandler })

    let result
    try {
      result = await this._runJob(items)
    } catch (err) {
      response.failed(err)
      throw err
    }
    if (!result.accepted) {
      const err = new Error(RUN_BUSY_ERROR_MESSAGE)
      response.failed(err)
      throw err
    }

    response.ids = result.ids
    this._groups.set(result.id, { ids: result.ids, response, pendingResult: null })
    for (const id of result.ids) this._chunkRoutes.set(id, result.id)
    return response
  }

  /** Route a streaming `BatchOutput` chunk to its group's response. */
  onOutput(data) {
    const jobId = this._chunkRoutes.get(data.id)
    const group = jobId === undefined ? null : this._groups.get(jobId)
    group?.response.updateOutput({ id: data.id, chunk: data.output })
  }

  /** Stash a group's final ordered output array until its JobEnded lands. */
  onResult(jobId, data) {
    const group = this._groups.get(jobId)
    if (group) group.pendingResult = data
  }

  /**
   * Terminal event for a group: build the `[ { id, output } ]` array the
   * consumer-facing `await()` resolves with, attach the group's stats, and
   * settle the response.
   */
  onJobEnded(jobId, stats) {
    const group = this._groups.get(jobId)
    if (!group) return
    const outputs = Array.isArray(group.pendingResult) ? group.pendingResult : []
    const finalResult = group.ids.map((id, index) => ({
      id,
      output: outputs[index] || ''
    }))
    if (stats != null) group.response.updateStats(stats)
    this._drop(jobId, group)
    group.response.ended(finalResult)
  }

  /** Fail one group; peers keep running. */
  onError(jobId, error) {
    const group = this._groups.get(jobId)
    if (!group) return
    this._drop(jobId, group)
    group.response.failed(error)
  }

  /**
   * Settle every in-flight group with @p error and drop all state; called on
   * unload so awaiting batch callers never hang.
   */
  failAll(error) {
    const groups = [...this._groups.values()]
    this.clear()
    for (const group of groups) group.response.failed(error)
  }

  /** Drop every group; called on unload/teardown. */
  clear() {
    this._groups.clear()
    this._chunkRoutes.clear()
  }

  _drop(jobId, group) {
    this._groups.delete(jobId)
    for (const id of group.ids) this._chunkRoutes.delete(id)
  }

  _unwrapItems(batchInput) {
    return batchInput.map((item) => {
      const isWrapped =
        item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.prompt)
      const prompt = isWrapped ? item.prompt : item
      const itemRunOptions = isWrapped && item.runOptions !== undefined ? item.runOptions : {}
      const unwrapped = { messages: this._parsePrompt(prompt, itemRunOptions) }
      if (isWrapped && item.id !== undefined) unwrapped.id = item.id
      return unwrapped
    })
  }
}

module.exports = BatchHandler
module.exports.RUN_BUSY_ERROR_MESSAGE = RUN_BUSY_ERROR_MESSAGE
