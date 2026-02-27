'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  STOPPED: 'stopped',
  PAUSED: 'paused'
})

const END_OF_INPUT = 'end of job'
const END_OF_OUTPUT = 'end of job'

class AddonInterface {
  constructor (configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the addon')
    // Configuration params will depend on the specific addon.
    // A new addon will be in LOADING status.
    this._state = state.LOADING
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this.jobId = 1
  }

  async loadWeights (weightsData) {
    console.log(`Loading weights: ${JSON.stringify(weightsData)}`)
    // After creating the addon, we allow weights to be loaded. The loadWeights
    // method accepts chunks of data to be loaded while the addon is in the LOADING
    // status. A call to activate() will be required to move the addon to IDLE status.
  }

  async destroy () {
    console.log('Destroyed the addon')
    // Clear resources on the C++ side.
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  async append ({ type, input, priority }) {
    const priorityStr = priority !== undefined ? ` with priority ${priority}` : ''
    console.log(`New chunk of data is appended: ${input}, type: ${type}${priorityStr}`)

    // Process data only if the addon is in a receptive state.
    if (this._state === state.LISTENING || this._state === state.PROCESSING) {
      if (type === END_OF_INPUT) {
        // Capture the current job id for the callback.
        const currentJob = this.jobId
        setImmediate(() => {
          // Emit a "job ended" event via the callback with the captured job id.
          this.outputCb(this, 'JobEnded', currentJob, { type: END_OF_OUTPUT }, null)
        })
        // Advance jobId for the next job.
        this.jobId = currentJob + 1
        return currentJob
      } else if (type === 'image') {
        // Transition to PROCESSING.
        this._state = state.PROCESSING
        if (this.transitionCb) {
          this.transitionCb(this, this._state)
        }
        const currentJob = this.jobId
        const output = [
          [[[25, 61], [62, 6], [82, 20], [46, 75]], 'tilted', 0.7302044630050659]
        ]
        setImmediate(() => {
          // Emit an output event.
          this.outputCb(this, 'Output', currentJob, output, null)
          // After processing, return to LISTENING state.
          this._state = state.LISTENING
          if (this.transitionCb) {
            this.transitionCb(this, this._state)
          }
        })
        return currentJob
      } else {
        const currentJob = this.jobId
        setImmediate(() => {
          this.outputCb(this, 'Error', currentJob, { error: `Unknown type: ${type}` }, null)
        })
        return currentJob
      }
    } else {
      // If not in a valid state, immediately emit an error.
      const currentJob = this.jobId
      setImmediate(() => {
        this.outputCb(this, 'Error', currentJob, { error: 'Invalid state for appending data' }, null)
      })
      return currentJob
    }
    // data type will depend on the specific addon.
    // This will allow adding more data to be processed
    // even while processing is in progress.
    // An ‘end of job’ value is required to break up the data
    // into separate jobs.
    // The Job ID of the job the data is appended to is returned
    // from the call to append().
    // The Job ID changes after a call to append() that includes
    // ‘end of job’
  }

  async activate () {
    console.log('Activated the addon')
    this._state = state.LISTENING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
    // Actives the plugin moving to PROCESSING,LISTENING, or IDLE status
    // If processing was paused, it starts from where it was paused. If it was
    // stopped, it will start from the next job.
    // Calling activate() on an already active plugin has no effect
    // Will be in PROCESSING status while new job data is processed
    // Will be in LISTENING status while waiting for ‘end of job’ value
    // Will be in IDLE status while waiting for next job
  }

  async pause () {
    console.log('Paused the processing')
    this._state = state.PAUSED
    // Interrupt the processing as soon as possible, but allow resuming.
    // Worker thread on C++ side needs to be set up to support this,
    // may depend on inference engine in use and data type
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  async stop () {
    console.log('Stopped the processing')
    this._state = state.STOPPED
    // Discards the current job and stops processing. When activate() is called
    // it will start from the next job on the queue.
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  async cancel (jobId) {
    console.log(`Cancel job id: ${jobId}`)
    this._state = state.STOPPED
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
    // Cancel a job by id. The job is removed from the queue. If jobId is
    // null, empty the queue, including the currently executing job.
    // If the current job is cancelled, discard it and continue with the
    // next one, as if calling stop() followed by activate().
    // No effect if a finished job or non-existent id is passed.
  }

  async status () {
    return this._state
    // Returns whether the plugin status is LOADING, PROCESSING, LISTENING, IDLE,
    // STOPPED, or PAUSED
  }

  async progress () {
    return { processed: 5, total: 10 }
    // Returns total size of input read, and amount processed
    // for the current job.
    // Processed / Size can give an approximation of % progress. However,
    // may not be completely reliable unless ‘end of job’ has been set,
    // as otherwise the size of input could continue to increase.
  }

  /* additional methods to query state */
}

module.exports = AddonInterface
