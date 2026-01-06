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

class MockedBinding {
  constructor () {
    this._handle = null
    this._state = state.LOADING
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the addon')
    // Configuration params will depend on the specific addon.
    // A new addon will be in LOADING status.
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._handle = { id: Date.now() } // Create a mock handle
    return this._handle
  }

  loadWeights (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log(`Loading weights: ${data.filename || data}`)
    // After creating the addon, we allow weights to be loaded. The loadWeights
    // method accepts chunks of data to be loaded while the addon is in the LOADING
    // status. A call to activate() will be required to move the addon to IDLE status.
    return true
  }

  destroyInstance (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._handle = null
    console.log('Destroyed the addon')
    // Clear resources on the C++ side.
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  append (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log(`New chunk of data is appended: ${data.input} of type: ${data.type}`)
    if (data.type === END_OF_INPUT) {
      setImmediate(() => this.outputCb(this, 'JobEnded', 1, { type: END_OF_OUTPUT }, null))
    } else {
      setImmediate(() => this.outputCb(this, 'Output', 1, 'mock response', null))
    }
    // data type will depend on the specific addon.
    // This will allow adding more data to be processed
    // even while processing is in progress.
    // An 'end of job' value is required to break up the data
    // into separate jobs.
    // The Job ID of the job the data is appended to is returned
    // from the call to append().
    // The Job ID changes after a call to append() that includes
    // 'end of job'
    return 1
  }

  activate (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
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
    // Will be in LISTENING status while waiting for 'end of job' value
    // Will be in IDLE status while waiting for next job
  }

  pause (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Paused the processing')
    this._state = state.PAUSED
    // Interrupt the processing as soon as possible, but allow resuming.
    // Worker thread on C++ side needs to be set up to support this,
    // may depend on inference engine in use and data type
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  stop (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Stopped the processing')
    this._state = state.STOPPED
    // Discards the current job and stops processing. When activate() is called
    // it will start from the next job on the queue.
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  cancel (handle, jobId) {
    if (handle !== this._handle) throw new Error('Invalid handle')
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

  status (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return this._state
    // Returns whether the plugin status is LOADING, PROCESSING, LISTENING, IDLE,
    // STOPPED, or PAUSED
  }

  progress (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return { processed: 5, total: 10 }
    // Returns total size of input read, and amount processed
    // for the current job.
    // Processed / Size can give an approximation of % progress. However,
    // may not be completely reliable unless 'end of job' has been set,
    // as otherwise the size of input could continue to increase.
  }

  reset (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Reset the model state')
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  /* additional methods to query state */
}

module.exports = MockedBinding
