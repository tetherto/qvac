const path = require('bare-path')

// Index-matched to the C++ GenerationStopReason enum (SequenceDriver.hpp).
const STOP_REASONS = [
  'none',
  'eos',
  'antiprompt',
  'predictionLimit',
  'sequenceLimit',
  'contextOverflow'
]

/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded` /
 * `FinetuneProgress`, or `null` to drop it.
 *
 * @param {string} rawEvent
 * @param {*} rawData
 * @param {*} rawError
 * @returns {{ type: string, data: *, error: * } | null}
 */
function mapAddonEvent(rawEvent, rawData, rawError) {
  // TPS-shaped runtime stats: a job's terminal snapshot. The one trailing a
  // finetune terminal carries the finetune's own id and routes to its sink.
  if (rawData && typeof rawData === 'object' && 'TPS' in rawData) {
    const stats = { ...rawData }
    if (stats.backendDevice === 0) {
      stats.backendDevice = 'cpu'
    } else if (stats.backendDevice === 1) {
      stats.backendDevice = 'gpu'
    }
    if (typeof stats.stopReason === 'number') {
      stats.stopReason = STOP_REASONS[stats.stopReason] || 'none'
    }
    return { type: 'JobEnded', data: stats, error: null }
  }

  // Finetune terminal: dispatch JobEnded carrying the finetune payload.
  if (
    rawData &&
    typeof rawData === 'object' &&
    rawData.op === 'finetune' &&
    typeof rawData.status === 'string'
  ) {
    return { type: 'JobEnded', data: rawData, error: null }
  }

  // Per-iteration finetune metrics.
  if (rawData && typeof rawData === 'object' && rawData.type === 'finetune_progress') {
    return { type: 'FinetuneProgress', data: rawData, error: null }
  }
  if (
    rawData &&
    typeof rawData === 'object' &&
    rawData.type === 'batch_output' &&
    typeof rawData.id === 'string'
  ) {
    return { type: 'BatchOutput', data: rawData, error: null }
  }
  if (Array.isArray(rawData)) {
    return { type: 'BatchResult', data: rawData, error: null }
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
  constructor(binding, configurationParams, outputCb) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    this._handle = this._binding.createInstance(this, configurationParams, outputCb, null)
  }

  /**
   * @param {Object} weightsData
   * @param {String} weightsData.filename
   * @param {Uint8Array|null} weightsData.chunk
   * @param {Boolean} weightsData.completed
   */
  loadWeights(weightsData) {
    return Promise.resolve(this._binding.loadWeights(this._handle, weightsData))
  }

  /**
   * Moves addon to the LISTENING state after all the initialization is done
   */
  activate() {
    return Promise.resolve(this._binding.activate(this._handle))
  }

  /**
   * @returns {number} active jobs (in-flight + queued) per the native
   * scheduler — the authoritative admission count.
   */
  activeJobs() {
    if (!this._handle) return 0
    return this._binding.activeJobs(this._handle)
  }

  /**
   * @returns {number} requests occupying or waiting for a continuous-batching
   * slot (active + pending). Capacity is consumed in slots, not jobs: one
   * batch job of N prompts takes up to N of them, so `activeJobs()` alone
   * under-reports a full pool. 0 when no batch scheduler is active
   * (`parallel: 1`), where the job count is the right measure — admission
   * therefore compares the max of the two against `parallel`.
   */
  activeSlots() {
    if (!this._handle) return 0
    return this._binding.activeSlots(this._handle)
  }

  /**
   * Cancel every inference job live at the moment of this call (or pause a
   * running finetune). Snapshot-based: the native binding captures the live
   * job ids synchronously before deferring the cancellation, so a job started
   * after this call is never touched.
   */
  async cancel(savePauseCheckpoint = 1) {
    if (!this._handle) return
    await this._binding.cancel(this._handle, savePauseCheckpoint)
  }

  /**
   * Cancel a single job by its native-assigned id, leaving other concurrent
   * jobs running. Routes to MultiJobScheduler::cancel(id) -> cancelById(id).
   * @param {number} id - job id minted by runJob()
   */
  async cancelJob(id) {
    if (!this._handle) return
    // The native binding treats a missing id as cancel-all; cancelling every
    // job is cancel()'s job, so require an explicit id here.
    if (typeof id !== 'number') {
      throw new TypeError(
        'cancelJob(id) requires a numeric job id; use cancel() to cancel all jobs'
      )
    }
    await this._binding.cancelJob(this._handle, id)
  }

  /**
   * Run finetuning when native binding provides support.
   */
  finetune(finetuningParams) {
    if (typeof this._binding.finetune !== 'function') {
      throw new Error('Finetuning is not exposed by this native binding')
    }
    if (finetuningParams === undefined) {
      throw new Error('Finetuning parameters are required')
    }
    return Promise.resolve(this._binding.finetune(this._handle, finetuningParams))
  }

  /**
   * Run one inference job with an array of message objects, or a batch of
   * jobs with an array of `{id?, messages}` items. The native binding mints
   * the job id (single) / group id (batch) and returns it so concurrent jobs
   * can be routed; a batch result also carries the per-item `ids` assigned
   * to each sequence.
   * @param {Array<{type: string, input?: string, content?: Uint8Array}> | Array<{id?: string, messages: Array<{type: string, input?: string, content?: Uint8Array}>}>} data - messages (text and/or media), or batch items
   * @returns {Promise<{accepted: true, id: number, ids?: string[]} | {accepted: false, ids?: string[]}>} admission result. The scheduler-minted job id (`id`) — the group id for a batch — is present only when `accepted` is true; a batch run additionally reports the per-item `ids` on both the accepted and rejected branches.
   */
  runJob(data) {
    return Promise.resolve(this._binding.runJob(this._handle, data))
  }

  /**
   * Unload the model and clear resources (including memory).
   */
  unload() {
    if (!this._handle) return Promise.resolve()
    this._binding.destroyInstance(this._handle)
    this._handle = null
    return Promise.resolve()
  }
}

module.exports = {
  LlamaInterface,
  mapAddonEvent
}
